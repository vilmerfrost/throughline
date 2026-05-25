# CLAUDE.md — Throughline

This file provides context for Claude Code sessions working on this codebase.

> **Self-Maintenance Rule:** Whenever you change the codebase (new files, renamed
> files, new endpoints, new analyzer stages, type-model changes, dependency or
> config changes) or learn something that makes a section here inaccurate, you
> **must** update this CLAUDE.md to reflect the new reality before finishing the
> task. Keep every section — principles, current state, commands, layout, key
> files, data model, endpoints, env, conventions — accurate and current. A stale
> instruction here is worse than no instruction.

## Project Overview

Throughline is a **read-only, multi-language codebase X-ray.** Point it at a
local repo; it renders a node graph showing how data flows — and, more
importantly, where it *doesn't* connect the way the developer assumed.

The graph is **contract-centric, not call-centric**: in a multi-language repo
the languages rarely call each other — they meet at shared data contracts (DB
tables, JSON/HTTP payloads). Contracts (SQL tables) are the spine; **touch**
nodes are places in code that read/write a contract; **boundary** nodes are
HTTP/JSON crossings where types are lost. Every touch carries a **trust** level.

Authoritative narrative: `README.md` (mental model) and `design.md` (full v1
design). The richest single source of design intent is the doc-comment block at
the top of `packages/core/src/types.ts` — read it before changing the data model.

---

## Core Principles — load-bearing, never violate

These are the reason the tool exists. Any change that weakens one of them is
wrong unless Vilmer explicitly relaxes the constraint. (Stated in `README.md` and
`design.md`; this section is the binding restatement.)

- **The tool must never lie.** Every node links to the *real* source that proves
  it — file path + line numbers + the actual code snippet (`SourceRef`). If a
  fact cannot be grounded in real code, it is not emitted. No invented columns,
  behavior, connections, or construction sites. When in doubt, the honest verdict
  is `unknown` / `dark` / `other` — never a guess dressed as a fact.
- **Trust is the whole point, and its tiers are sacred.** `verified` (green) =
  inferred type, no cast. `narrowed` (yellow) = `Pick`/`Omit` or partial select,
  fields dropped. `asserted` (red) = an `as X` cast — the developer said "trust
  me", NOT verified. `dark` (near-black) = `any`/`never`/untyped JSON. **Never
  fold anything into `verified` that the compiler didn't actually verify.**
  `schemaMatch` (aligned/mismatch/dark) is a *separate* axis from `trust` and
  must never be merged into it.
- **Claims are scoped to what's statically provable.** v1 drift is **table-level
  only** — Throughline does NOT claim specific columns are missing/added/renamed/
  mistyped, EXCEPT the Stage-1a Rust path which makes field-level claims ONLY
  when grounded in a resolved write payload. Semantic/data-lineage links
  ("readings feed scores") are not statically provable and are NEVER emitted.
- **Analyzer depth is honest per language.** SQL = contract (deep, defines the
  spine), TypeScript = deep (`ts-morph`), Python + Rust = shallow grep only. A
  Python/Rust touch is `dark` *by analyzer definition*, not because the user's
  code is bad — the explainer must say so. See `ANALYZER_DEPTH` in `types.ts`.
- **AI commentary is grounded, never authoritative.** `/explain` and `/fix-prompt`
  reason ONLY from facts Throughline already extracted (kind, trust, verbatim
  snippet, columns, drift). The source snippet is the source of truth; AI text is
  commentary, rendered visually distinct. The `OPENROUTER_API_KEY` is **server-side
  only** and must never reach the browser — the frontend only ever calls the
  analyzer's `POST /explain` and `POST /fix-prompt`. Model is configurable via
  `OPENROUTER_MODEL`, default `google/gemini-3.5-flash`.
- **Additive evolution.** New model fields are added optional (`?`) so existing
  consumers — including the offline mock graph — keep compiling. Don't make
  breaking changes to `Graph`/`GraphNode` without updating every consumer.

---

## Current State — v1, evolving

v1 is shipped (`b319d3b` "full v1 done", `cac280e` "v.1.5"). The analyzer composes
several additive stages on top of the core contract/touch/trust graph. Each stage
is verified by a real-repo report script, not just unit tests (see Conventions).

**Shipped:**
- **Core graph** — SQL contracts + TS deep touches + Python/Rust shallow touches,
  trust classification, table-level drift. (`parseSchema`, `parseTs`, `grepShallow`, `detectDrift`)
- **Stage 1a — Rust schema-match** — deep-parses Rust write payloads, stamps
  `schemaMatch` (aligned/mismatch/dark) onto still-`dark` Rust touches + grounded
  column-level drift. `trust` left as-is. (`rust/parseRust.ts`, `rust/schemaMatch.ts`)
- **Column usage + B1/B2 reach axis** — per-column read verdicts (`used`/`likely_*`/
  `unknown`) and a `reach` axis (where the value travels: `ui_shown`/`server_only`/
  `never_read`/`unknown`). TypeScript reach is augmented by grounded SQL view read
  evidence from migration `CREATE VIEW` statements: precise view columns become
  DB-side `used`/`server_only`; opaque views prevent false `never_read` claims by
  making affected columns `unknown`. (`ts/columnUsage.ts`, `ts/reach.ts`,
  `sql/parseSql.ts`)
- **RC-a — root-cause rollup** — deterministic grouping of dark/asserted TS
  touches by (reason, client-origin); "fix THIS construction → flip N touches",
  ranked biggest-lever-first. Unresolved origins classified by `UnresolvedShape`.
  Surfaced as the Root Causes view in the web UI. (`ts/rootCause.ts`, `RootCausesView.tsx`)
- **SQL view readers** — extracts view-defined reads from migrations with honest
  confidence: `certain` only for attributable base-table columns (`t.col`, `t.*`,
  or single-table `*` expanded against known schema), `opaque` for CTE/subquery/
  ambiguous shapes. View reads are evidence that the DB computes/serves a value,
  not proof that a user sees it. (`SqlViewRead`, `parseSql.ts`, `verify-reach.mts`)
- **Source scope + simple TS table helpers** — every touch is classified by file
  scope (`production`/`test`/`migration`/`script`/`generated`/`unknown`) so
  drift/root-cause/MCP output can distinguish production impact from test-only
  evidence. The TS analyzer also follows simple helpers that return one obvious
  `client.from('<table>')`, preserving table identity at call sites like
  `adapterRunsTable(admin).insert(...)` without broad interprocedural claims.
  (`sourceScope.ts`, `ts/tableHelpers.ts`, `parseTs.ts`, `columnUsage.ts`, `reach.ts`)
- **FK-A1 — declared relationships** — extracts declared foreign keys from
  migrations (inline / table-level / `ALTER ADD CONSTRAINT`) with honest
  cardinality inference. Surfaced as the FK neighborhood band in the focus view.
  (`sql/parseSql.ts` `parseSchema`, `RelationshipBand.tsx`, `lib/relationships.ts`)
- **MCP server** — `@throughline/mcp` calls `buildGraph` in-process and exposes
  the graph's grounded facts to agents via `@modelcontextprotocol/sdk`. Read-only
  tools: `get_table`, `get_file`, `get_node_context`, `get_root_causes`,
  `reanalyze` (the only way a verdict moves — re-derives from disk). Plus
  `check_write` (MCP Stage 2) — a **pure, preventive** validation of a *proposed*
  insert/update against the schema (`would_align`/`would_mismatch`, names+presence
  only, never type-checks values, mutates nothing). It reuses the analyzer's ONE
  shared field comparison (`schema/compareFields.ts` `compareWriteFields`) so the
  Rust write analyzer and `check_write` can never disagree. (`packages/mcp/`)

**In progress / next:** B2 (reach axis in the UI). Uncommitted work currently on
disk touches `RelationshipBand`, `lib/relationships.ts`, and FK tests.

**Default analysis target:** the analyzer hardcodes a fallback repo path of
`/Users/vilmerfrost/Projects/Batch-Guard.ai-2` (and normalizes `batchgaurd`/
`batchguard` typos) — this is the standard real-repo verification target.

---

## Commands

```bash
pnpm install
pnpm dev        # analyzer on :4000 + web on :5173 (concurrently)
pnpm typecheck  # THE gate: 3 sequential `tsc --noEmit` (core → analyzer → web)
pnpm build      # runs typecheck, then builds the web app

pnpm --filter @throughline/analyzer dev    # analyzer alone (tsx watch)
pnpm --filter @throughline/analyzer test   # analyzer unit tests (node:test + tsx)
pnpm --filter @throughline/mcp test        # MCP package tests (NOT in root typecheck gate)
pnpm --filter @throughline/web dev         # web alone — falls back to bundled demo graph

# Real-repo verification reports (honesty checks, NOT unit tests — see Conventions):
pnpm --filter @throughline/analyzer exec tsx scripts/verify-fk.mts [repoPath]
pnpm --filter @throughline/analyzer exec tsx scripts/verify-reach.mts [repoPath]
pnpm --filter @throughline/analyzer exec tsx scripts/verify-rootcause.mts [repoPath]
pnpm --filter @throughline/analyzer exec tsx scripts/verify-client-alias.mts [repoPath]  # isTypedClient vs behavioral truth
```

---

## Architecture & Data Flow

```
local repo on disk
      ↓
Analyzer (Express, :4000)  — buildGraph(repoPath) [in buildGraph.ts] composes additive stages:
  parseSchema(SQL)  → contract nodes + FK relationships + SQL view reads
  loadProject       → one shared ts-morph Project (type resolution paid once)
  parseTs           → deep TS touches + edges + rootCauses + simple table helper aliases
  grepShallow       → shallow Python/Rust touches + edges
  computeColumnUsage→ per-column read verdicts + reach (TS + SQL view evidence, attached to contracts)
  analyzeRustWrites → Stage 1a schemaMatch + grounded Rust drift
  detectDrift       → table-level drift findings
      ↓ Graph JSON
Web (Vite + React + React Flow, :5173)
  - React Flow renders nodes colored by trust; click → Inspector + real snippet
  - three-tab nav: graph / focus (FK band) / Root Causes
  - "Explain this node" / fix-prompt → analyzer (key stays server-side)
  - falls back to a bundled offline demo graph if the analyzer is unreachable
```

---

## Layout

```
throughline/
├── packages/
│   ├── core/      # @throughline/core — shared graph types ONLY (ships raw src/types.ts, no build)
│   ├── analyzer/  # @throughline/analyzer — Express server + per-language analyzers + verify scripts
│   └── mcp/       # @throughline/mcp — MCP server (@modelcontextprotocol/sdk + zod) exposing graph facts to agents; calls buildGraph in-process
└── apps/
    └── web/       # @throughline/web — Vite + React + Tailwind + React Flow UI
```

> ⚠️ The root `pnpm typecheck` covers **core → analyzer → web only**. It does NOT
> include `packages/mcp`. Run `pnpm --filter @throughline/mcp test` (and a
> `tsc -p packages/mcp/tsconfig.json --noEmit`) separately when touching the MCP
> package, and consider adding it to the root gate.

---

## Key Files

| File | Purpose |
| --- | --- |
| `packages/core/src/types.ts` | The entire data model + design intent in doc-comments. Single source of truth for the contract/touch/trust/drift/RootCause/Relationship shapes. **Read before changing the model.** |
| `packages/analyzer/src/index.ts` | Express server + endpoints (`/health` `/analyze` `/explain` `/fix-prompt`) + hardcoded default-repo resolution |
| `packages/analyzer/src/buildGraph.ts` | `buildGraph(repoPath)` — composes all analyzer stages into a `Graph`. Extracted from `index.ts` so the MCP server can call it in-process without booting Express. |
| `packages/mcp/README.md` | MCP tool reference + **how to connect an agent** (Claude Code `claude mcp add`, Claude Desktop / `.mcp.json`, env/argv repo selection) |
| `packages/mcp/src/index.ts` + `server.ts` + `facts.ts` | MCP server entry + tool registration + the functions that turn a `Graph` into agent-readable facts (incl. `checkWrite`) |
| `packages/analyzer/src/schema/compareFields.ts` | `compareWriteFields` — the ONE pure field-names-vs-schema comparison shared by the Rust write analyzer and MCP `check_write` (insert/update rules + `hasDefault`); exported via `@throughline/analyzer/schema/compareFields` |
| `packages/analyzer/src/sql/parseSql.ts` | `parseSchema` — SQL contract nodes (via `pgsql-ast-parser`) + FK-A1 declared relationships |
| `packages/analyzer/src/sourceScope.ts` | File-path source scope classifier for touch facts (`production`/`test`/`migration`/`script`/`generated`/`unknown`) |
| `packages/analyzer/src/ts/parseTs.ts` | Deep TS analyzer (`ts-morph`): trust classification, touches, edges, root causes. `isTypedClient` decides `SupabaseClient<Database>` by the receiver's resolved **symbol + first type-argument** (not `getText()` substrings), so it sees through type aliases (`type Admin = SupabaseClient<Database>`) and alias chains, while keeping bare `SupabaseClient` / `<any>` / a `& SupabaseClient` intersection's bare arm `dark`. Validated against behavioral truth (the real `.from()` query-builder result) by `scripts/verify-client-alias.mts`. |
| `packages/analyzer/src/ts/tableHelpers.ts` | Conservative simple Supabase helper detection (`function x(client) { return client.from('table') }`) shared by TS touch, column usage, and reach passes |
| `packages/analyzer/src/ts/columnUsage.ts` | Per-column read verdicts attached to contract nodes |
| `packages/analyzer/src/ts/reach.ts` | B1 reach axis — where a read column's value travels |
| `packages/analyzer/src/ts/rootCause.ts` | RC-a deterministic root-cause rollup |
| `packages/analyzer/src/rust/parseRust.ts` + `schemaMatch.ts` | Stage 1a Rust deep write-payload parse + struct-vs-schema verdict |
| `packages/analyzer/src/shallow/grep.ts` | Shallow Python/Rust touch detection |
| `packages/analyzer/src/drift/detect.ts` | Table-level drift findings |
| `packages/analyzer/src/explain.ts` + `fixPrompt.ts` | Grounded LLM commentary + agent-ready fix prompts (OpenRouter, server-side) |
| `packages/analyzer/scripts/verify-*.mts` | Real-repo honesty-check report scripts (FK / reach / root-cause) |
| `apps/web/src/App.tsx` | Three-tab shell (graph / focus / Root Causes) + analyzer client + offline fallback |
| `apps/web/src/lib/api.ts` | Frontend → analyzer client (only path to the server-side key) |
| `apps/web/src/components/RootCausesView.tsx` + `RootCauseCard.tsx` + `FixPromptBlock.tsx` | RC-a UI |
| `apps/web/src/components/RelationshipBand.tsx` + `lib/relationships.ts` | FK-A1 neighborhood band in the focus view |
| `apps/web/src/mock/` | Bundled offline demo graph (must keep compiling — model changes are additive/optional) |

---

## Data Model (core types)

All in `packages/core/src/types.ts`. The load-bearing types:

- `Graph` — `{ repoPath, nodes, edges, drift, rootCauses?, relationships?, sqlViewReads?, helperAliases?, generatedAt }`
- `GraphNode` — `kind: 'contract'|'touch'|'boundary'`; contracts carry `columns` +
  `columnUsage`; touches carry `trust` + `trustReason` + `schemaMatch?` +
  `sourceScope?` + `source`
- `Trust` = `verified | narrowed | asserted | dark` — see Core Principles
- `TrustReason` + `TRUST_REASON_DESCRIPTIONS` — analyzer owns the machine-readable
  reason; explainer surfaces it instead of inventing one. Keep them in sync.
- `SchemaMatch` = `aligned | mismatch | dark` — separate axis, Rust writes only
- `ColumnUsage` (`verdict` + `certain` + `evidence` + `reach?` + `escapeTrail?`)
- `SqlViewRead` (`viewName` + `table` + `confidence` + optional `columns` +
  `source`) — grounded migration view read evidence; `opaque` prevents false
  no-reader claims but never claims exact columns.
- `SourceScope` = `production | test | migration | script | generated | unknown` —
  separate from trust/confidence; test evidence is real but summarized differently.
- `TableHelperAlias` — simple TS helper facts for one-table Supabase helpers only.
- `RootCause` + `RootCauseOrigin` + `UnresolvedShape`
- `Relationship` + `Cardinality` (`many-to-one` default; `one-to-one` only when the
  FK column is itself a PK or single-column UNIQUE; composite FKs stay many-to-one)

---

## Environment Variables

Optional, in `.env.local` (gitignored; `dotenv` loads from repo root and the
analyzer package dir):

```
OPENROUTER_API_KEY=sk-or-...           # enables "Explain this node" + fix-prompt polish.
                                       # SERVER-SIDE ONLY. Without it those endpoints
                                       # return a clear error and nothing else breaks.
OPENROUTER_MODEL=google/gemini-3.5-flash   # optional override; this is the default
                                       # (DEFAULT_MODEL in src/explain.ts)
```

---

## Conventions

### Honesty (the analyzer's prime directive)
- A node without a real `SourceRef` is not emitted. Don't synthesize snippets,
  line numbers, columns, or construction sites.
- Unsure → emit the honest fallback (`unknown` / `dark` / `other`), never a guess.
- Keep `trust`, `schemaMatch`, and the `reach` axis as separate axes. Do not merge.
- Keep `sourceScope` separate too. Do not globally skip tests; classify them and
  avoid mixing test-only risk with production impact.
- Reach is scoped to scanned TypeScript UI plus migration-defined SQL views.
  `server_only` means outside scanned JSX, not "safe to delete"; `never_read`
  means no scanned reader found, not proof of dead data. Python/Rust/raw SQL/
  external agents can still consume columns unless specifically analyzed.
- TS drift coverage gets sharper after Supabase clients carry
  `SupabaseClient<Database>`. Loose clients and usage-site casts can hide
  wrong-column reads from both TypeScript and Throughline until types are
  tightened.
- New `Graph`/`GraphNode` fields are **optional + additive** so the mock and other
  consumers keep compiling.

### Verification
- Every analyzer stage is verified by a **real-repo report script**
  (`scripts/verify-*.mts`) that runs the actual analyzer over a real codebase and
  reports honest results (counts, unresolved targets, spot-checks against disk) —
  NOT just unit tests. When you add a stage, add/extend a verify script and run it
  against `Batch-Guard.ai-2` before claiming the feature works.

### TypeScript / build
- `pnpm typecheck` is the real gate: three sequential `tsc --noEmit` runs
  (core → analyzer → web). `pnpm build` runs it first.
- Strict mode, plus `noUnusedLocals` / `noUnusedParameters` — unused vars FAIL the
  build. `noFallthroughCasesInSwitch` is on.
- ESM throughout (`"type": "module"`), `moduleResolution: Bundler`. Analyzer imports
  use `.js` extensions on relative paths (e.g. `./sql/parseSql.js`).

### Testing gotchas
- Tests use Node's built-in runner (`node --import tsx --test`) and import from
  `node:test`. They live in the **analyzer** package (`src/**/*.test.ts`).
- The **web** tsconfig **excludes** `src/**/*.test.ts` precisely because they use
  `node:test` — do NOT remove that exclude or web typecheck breaks.

### pgsql-ast-parser
- It requires **explicit column lists** in `REFERENCES` clauses (both inline and
  table-level FK syntax). FK extraction relies on this — don't assume implicit-PK
  references resolve.

---

## Tech Stack

- **Monorepo**: pnpm workspaces (`packages/*`, `apps/*`), TypeScript 5.6, ESM, Node 22
- **core**: types only — `main`/`types` point at raw `src/types.ts`, no build step
- **analyzer**: Express 4, `ts-morph` (deep TS), `pgsql-ast-parser` (SQL),
  `web-tree-sitter` + `tree-sitter-wasms` (shallow), `dotenv`, `cors`; runs via `tsx`
- **web**: Vite 5, React 18, `@xyflow/react` (React Flow), `dagre` layout, Tailwind 3,
  `lucide-react` (node/legend icons)
- **AI**: OpenRouter (`google/gemini-3.5-flash` by default, `OPENROUTER_MODEL`-overridable), server-side only

---

## Tooling — CLIs, Skills, MCP

This repo has **no project-scoped `.claude/`**; all of the below is globally
installed (see `~/.claude/CLAUDE.md`). Throughline is a **local, read-only**
tool — it has no cloud deploy target, DB, or auth — so the deploy/DB CLIs and
MCP servers below are general-purpose, not part of this project's workflow.

### CLIs (globally available)

| CLI | Relevance to Throughline |
| --- | --- |
| `gh` | PRs, issues, CI — the one that's directly useful here |
| `ports` | Free/inspect ports `4000` (analyzer) + `5173` (web) when a dev server is stuck (`ports clean`) |
| `bun` | Fast JS/TS runtime (used by claude-mem) |
| `vercel` / `supabase` / `railway` | Installed globally but **not used by this project** — Throughline doesn't deploy or own a DB. Don't introduce a dependency on them without a reason. |

### Skills (globally installed plugins — invoke proactively, don't wait for a slash command)

- **Superpowers** — process discipline: `brainstorming` (before any feature),
  `systematic-debugging` (any bug), `test-driven-development`, `writing-plans` /
  `executing-plans`, `requesting-code-review`, `verification-before-completion`.
- **Compound Engineering** — structured workflow: `ce:ideate → ce:brainstorm →
  ce:plan → ce:work → ce:review → ce:compound`. Prefer planning before building
  anything beyond a one-line change.
- **Claude-Mem** — persistent cross-session memory via hooks (auto). `/mem-search`
  or `npx claude-mem search "<query>"` to recall past work; viewer at `:37777`.
- **frontend-design** / **vercel-react-best-practices** — for the React Flow web UI.
- **release-auditor** — forensic pre-push/ship audit ("is this safe to ship").

**Priority:** process skills first (brainstorm/debug/plan), implementation skills
second. Even a 1% chance a skill applies → invoke it.

### MCP servers (globally connected, general-purpose)

GitHub, Context7 (library docs — prefer over web search), Supabase, Vercel,
Playwright/Puppeteer, Figma, plus claude-mem search. **Use Context7 for any
library/API/CLI doc lookup** (e.g. `ts-morph`, `pgsql-ast-parser`, React Flow,
`web-tree-sitter`) — training data may be stale.
