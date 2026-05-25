# Throughline

A **read-only, multi-language codebase X-ray.** Point it at a local repo; it
renders a node graph showing how data flows — and, more importantly, where it
*doesn't* connect the way the developer assumed.

> **Core philosophy: the tool must never lie.** Every node links to the real
> source (file path + line numbers + the actual code snippet) that proves it. If
> a fact can't be grounded in real code, Throughline doesn't emit it. When unsure,
> it says so — `unknown` / `dark` / `other` — instead of guessing.

## The mental model

The graph is **contract-centric**, not call-centric. In a multi-language repo the
languages mostly don't call each other — they meet at shared data contracts
(database tables, JSON/HTTP payloads).

- **Contracts** (DB tables) are the spine.
- **Touch nodes** are places in code that read or write a contract.
- **Boundary nodes** are HTTP/JSON crossing points where types are lost.
- Each touch/boundary carries a **trust** level — the whole point:
  - `verified` (green) — inferred type, no cast; genuinely connected.
  - `narrowed` (yellow) — `Pick`/`Omit` or partial column select; fields dropped.
  - `asserted` (red) — an `as X` cast; the developer said "trust me", NOT verified.
  - `dark` (near-black) — `any`/`never`/untyped JSON boundary; flow went blind.
- **Drift findings** — table-level divergence risks where languages touch the
  same contract with different trust guarantees. v1 does not claim specific
  columns are missing, added, renamed, or mistyped — *except* where a claim is
  grounded in a resolved write payload (see "Schema match" below).

### Analyzer depth (honest per language)

- **SQL migrations** → parsed as the contract spine: tables, columns, declared
  FKs, view read evidence, and migration/seed/trigger writers.
- **TypeScript** → parsed deeply via `ts-morph`: reads, writes, casts, type
  resolution, table helper aliases, column usage, and reach.
- **Rust** → shallow touch detection plus deep schema-match for resolvable write
  payloads, including conditional `serde` serialization handling.
- **Python** → shallow touch detection plus supabase-py payload tracing for
  simple `.table(...).insert/update/upsert(...).execute()` writes.

Every touch carries an `analysisDepth` axis (`deep`, `shallow`, `contract`, or
`analyzer_limit`) so the UI and MCP can say whether a verdict came from deep
analysis or an honest analyzer boundary. Python and Rust touches still display
`dark` trust unless the compiler itself verified the contract; their resolved
payload checks live on the separate `schemaMatch` axis.

## What's in the graph (v1)

On top of the base contract/touch/trust graph, the analyzer composes several
additive layers, each grounded in real source:

- **Schema match (Rust writes).** Deep-parses Rust write payloads and stamps an
  `aligned` / `mismatch` / `dark` verdict against the SQL schema — a *separate*
  axis from trust, never folded into "verified". A `mismatch` (a NOT-NULL column
  missing, or a written key not in the schema) is a real, field-level claim
  grounded in the resolved struct. Conditional `serde` fields are reported as
  investigation-oriented risk rather than false missing-column claims.
- **Schema match (Python writes).** Resolves simple supabase-py write payloads
  (literal dicts, `dict(...)`, kwargs, lists of literal dicts, and local payload
  variables) and compares field names against the same SQL spine.
- **SQL writers.** Finds top-level SQL DML in migrations and seeds, and DML inside
  Postgres function bodies. Writes carry a `lifecycle` axis (`runtime`,
  `migration`, `seed`, `trigger`) so backfills and trigger effects do not get
  mixed into app-runtime writer risk.
- **Column usage + reach.** Per-column read verdicts for each contract
  (`used` is certain; `likely_used` / `likely_rendered` / `likely_dead` /
  `unknown` are labelled heuristics), plus a *reach* axis — where a read column's
  value travels (`ui_shown` / `server_only` / `never_read` / `unknown`). SQL view
  reads can prove DB-side use; opaque views prevent false no-reader claims.
  `never_read` means "no scanned reader found", not "safe to delete".
- **Root causes.** A deterministic rollup of dark/asserted TypeScript touches that
  share a (reason, client-origin): *"fix THIS construction → flip N touches"*,
  ranked biggest-lever-first. Pure grouping of already-computed facts — no LLM,
  no inference. Unresolved origins are classified by shape (parameter / ref /
  imported-untyped / other) so the bucket stays actionable.
- **Declared relationships (FK).** Foreign keys extracted from the migrations
  (inline, table-level, or `ALTER ... ADD CONSTRAINT`) with honest cardinality
  (`many-to-one` by default; `one-to-one` only when the FK column is itself a PK
  or single-column UNIQUE). Only *declared* FKs — semantic "this feeds that"
  links are not statically provable and are never emitted.
- **Source scope + drift taxonomy.** Facts carry `sourceScope` (`production`,
  `test`, `migration`, `script`, `generated`, `unknown`), and drift findings carry
  a `kind`, `fixability`, recommended action, and `driftSummary` rollup. Test-only
  evidence stays real, but it is not summarized as production risk.

## Layout

```
throughline/
├── packages/
│   ├── core/        # @throughline/core — the shared graph data model (types only)
│   ├── analyzer/    # @throughline/analyzer — Express server + per-language analyzers
│   └── mcp/         # @throughline/mcp — MCP server exposing grounded facts to agents
└── apps/
    └── web/         # @throughline/web — Vite + React + Tailwind + React Flow UI
```

The single best description of the data model and design intent is the
doc-comment block at the top of `packages/core/src/types.ts`.

## Run it

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts both:

- the **analyzer** on http://localhost:4000 (`GET /analyze?path=...` → Graph JSON)
- the **web** app on http://localhost:5173

Open the web app. It has three views:

- **Graph** — React Flow renders every node colored by trust; click any node to
  open the Inspector and see its notes + real source snippet. A legend explains
  the four trust colors.
- **Focus** — a single contract and its neighborhood, including the declared-FK
  relationship band beneath the data-touch canvas.
- **Root Causes** — the ranked "fix this → flip N touches" levers, each with a
  generated fix prompt.

The web app falls back to a bundled offline demo graph if the analyzer is
unreachable, so it also runs standalone (`pnpm --filter @throughline/web dev`).

### Other commands

```bash
pnpm typecheck                              # the gate: 3× tsc --noEmit (core → analyzer → web)
pnpm build                                  # typecheck, then build the web app
pnpm --filter @throughline/analyzer test    # analyzer unit tests (node:test + tsx)
pnpm --filter @throughline/mcp test         # MCP package tests
pnpm --filter @throughline/mcp exec tsc -p tsconfig.json --noEmit

# Real-repo verification reports (honesty checks over an actual codebase, not just unit tests):
pnpm --filter @throughline/analyzer exec tsx scripts/verify-fk.mts [repoPath]
pnpm --filter @throughline/analyzer exec tsx scripts/verify-reach.mts [repoPath]
pnpm --filter @throughline/analyzer exec tsx scripts/verify-rootcause.mts [repoPath]
```

## "Explain this node" + fix prompts (optional AI commentary)

The Inspector has an **Explain this node** button that asks an LLM (via
OpenRouter) to explain the selected node in plain language, and a **fix prompt**
generator that produces an agent-ready task for the receiving codebase. Both are
grounded by an honesty contract: the model reasons **only** from the verified
facts Throughline already extracted (the node's kind, trust level, verbatim
source snippet, schema columns, and drift findings) and is instructed never to
invent columns, behavior, or connections. The explanation is rendered visually
distinct from the grounded facts — the source snippet remains the source of
truth; the AI text is commentary.

The OpenRouter API key is used **server-side only** and never reaches the browser
(the frontend only ever calls the analyzer's `POST /explain` and `POST /fix-prompt`).

```bash
cp .env.example .env.local   # gitignored
# then set OPENROUTER_API_KEY=sk-or-...
```

The default model is `google/gemini-3.5-flash`; override it with
`OPENROUTER_MODEL`. Without an API key set, the buttons return a clear error
("OPENROUTER_API_KEY not set") and nothing else breaks.

## MCP facts for agents

`@throughline/mcp` is built. It calls `buildGraph(repoPath)` in-process, without
booting the Express server, and exposes the same grounded graph facts over stdio.

Agents get read-only tools for:

- `about_throughline` and the `throughline://about` resource — how to use the
  tool without confusing trust, `schemaMatch`, reach, lifecycle, or
  `analysisDepth`.
- `get_analysis_target` — confirm which local repo the MCP cache currently
  represents.
- `set_analysis_target` — validate a local directory, rebuild from disk with
  `buildGraph(resolvedPath)`, then swap only the in-memory MCP cache after
  success. It never accepts agent-supplied verdicts or graph fragments.
- `get_table`, `get_file`, `get_node_context`, and `get_root_causes` — grounded
  facts with real snippets, analyzer reasons, FK neighbors, source scope, and
  current `analyzed_at`.
- `check_write` — a pure preventive check of proposed insert/update field names
  against the schema snapshot (`would_align` / `would_mismatch`), sharing the
  analyzer's field comparison with Rust schema-match. It never type-checks values
  and mutates nothing.
- `reanalyze` — refresh the same target from disk; the only way a verdict moves
  for that target.

The default analysis target used by the analyzer and MCP examples is
`/Users/vilmerfrost/Projects/Batch-Guard.ai-2`, the standard real-repo
verification target.
