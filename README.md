# Throughline

A **read-only, multi-language codebase X-ray.** Point it at a local repo; it
renders a node graph showing how data flows — and, more importantly, where it
*doesn't* connect the way the developer assumed.

> **Core philosophy: the tool must never lie.** Every node links to the real
> source (file path + line numbers + the actual code snippet) that proves it.

Throughline's analyzer is implemented for the current v1 scope: SQL migrations
define contract nodes, TypeScript Supabase calls define typed touch nodes,
Python/Rust are scanned shallowly, and drift findings are table-level only.

## The mental model

The graph is **contract-centric**, not call-centric. In a multi-language repo
the languages mostly don't call each other — they meet at shared data contracts
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
  columns are missing, added, renamed, or mistyped.

### Analyzer depth

- **SQL migrations** → parsed deeply (defines the contracts/columns).
- **TypeScript** → parsed deeply via `ts-morph` (reads, writes, casts).
- **Python / Rust** → shallow grep only (detect that they write a table),
  compared against the SQL contract spine.
- **Drift** → compares table-level language, direction, and trust signals.

## Layout

```
throughline/
├── packages/
│   ├── core/        # @throughline/core — the shared graph data model (types only)
│   └── analyzer/    # @throughline/analyzer — Express server + analyzers
└── apps/
    └── web/         # @throughline/web — Vite + React + Tailwind + React Flow UI
```

## Run it

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts both:

- the **analyzer** on http://localhost:4000 (`GET /analyze?path=...` → Graph JSON)
- the **web** app on http://localhost:5173

Open the web app. React Flow renders the graph with nodes colored by trust; click
any node to open the Inspector and see its notes + real source snippet. A legend
explains the four trust colors.

The web app falls back to a bundled offline demo graph if the analyzer is
unreachable, so it also runs standalone (`pnpm --filter @throughline/web dev`).

## "Explain this node" (optional AI commentary)

The Inspector has an **Explain this node** button that asks an LLM (via
OpenRouter, `anthropic/claude-sonnet-4.6`) to explain the selected node in plain
language. It is grounded by an honesty contract: the model reasons **only** from
the verified facts Throughline already extracted (the node's kind, trust level,
verbatim source snippet, schema columns, and drift findings) and is instructed
never to invent columns, behavior, or connections. The explanation is rendered
visually distinct from the grounded facts — the source snippet remains the
source of truth; the AI text is commentary.

The OpenRouter API key is used **server-side only** and never reaches the
browser (the frontend only ever calls the analyzer's `POST /explain`).

```bash
cp .env.example .env.local   # gitignored
# then set OPENROUTER_API_KEY=sk-or-...
```

Without the key set, the button returns a clear error ("OPENROUTER_API_KEY not
set") and nothing else breaks.
