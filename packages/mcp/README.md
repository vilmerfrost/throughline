# @throughline/mcp

A read-only MCP server that exposes Throughline's grounded analysis to agents over
stdio. It calls `buildGraph(repoPath)` in-process (no Express boot) and turns the
resulting `Graph` into agent-readable facts. **No tool changes a verdict** — green
is only ever re-earned by changing code on disk and calling `reanalyze`.

## Tools

| Tool | What it returns | Mutates? |
| --- | --- | --- |
| `get_table` | Contract facts for a table: columns (type/nullable/default + read reach), writer/reader touches with trust or schemaMatch + analyzer reason, drift, FK neighbors | no |
| `get_file` | Every data-contract touch in a file, each with its verdict, reason, source snippet, direction, and tables touched | no |
| `get_node_context` | Full context for one touch by nodeId: its verdict, the contract it touches, sibling touches + FK neighbors | no |
| `get_root_causes` | The deterministic root-cause rollup, ranked biggest-lever-first | no |
| `check_write` | **Pure preventive** validation of a *proposed* insert/update vs the schema → `would_align`/`would_mismatch` + `missingRequired`/`unknownKeys`. Names + presence only (never type-checks values). Unknown table → no verdict. | **no — changes nothing, `analyzed_at` untouched** |
| `reanalyze` | Re-derives the whole graph from disk and replaces the cache; returns fresh + previous `analyzed_at` and per-field deltas | the graph cache (the only tool that moves a verdict) |

`check_write` and the Rust write analyzer share **one** comparison
(`@throughline/analyzer/schema/compareFields` → `compareWriteFields`), so they can
never disagree about what "aligns with the schema".

## Connecting an agent

The server runs the TypeScript entry via the package-local `tsx`. The target repo is
`argv[2]`, else `THROUGHLINE_REPO`, else the default `Batch-Guard.ai-2`. **stdout is
the MCP protocol channel; all logs go to stderr.**

It must launch with this monorepo's `node_modules` reachable (it imports the
`@throughline/analyzer` workspace package), so prefer the absolute package-local
`tsx` shown below.

### Claude Code

```bash
claude mcp add throughline \
  -- /Users/vilmerfrost/Projects/throughline/packages/mcp/node_modules/.bin/tsx \
     /Users/vilmerfrost/Projects/throughline/packages/mcp/src/index.ts \
     /Users/vilmerfrost/Projects/Batch-Guard.ai-2
```

Swap the last argument for the repo you want to X-ray. `claude mcp list` should then
show `throughline` connected.

### Claude Desktop / any MCP client (JSON)

In `claude_desktop_config.json` (or a project `.mcp.json`):

```json
{
  "mcpServers": {
    "throughline": {
      "command": "/Users/vilmerfrost/Projects/throughline/packages/mcp/node_modules/.bin/tsx",
      "args": ["/Users/vilmerfrost/Projects/throughline/packages/mcp/src/index.ts"],
      "env": { "THROUGHLINE_REPO": "/Users/vilmerfrost/Projects/Batch-Guard.ai-2" }
    }
  }
}
```

`pnpm --filter @throughline/mcp start <repoPath>` also works, but only when the
client's working directory is inside this workspace.

## Using check_write

Call it before writing a DB write to catch a drifted payload preventively:

```jsonc
// tool: check_write
{ "table": "events_log", "fields": ["batch_id", "event_type", "previous_hash"], "verb": "insert" }
// → { "verdict": "would_mismatch", "unknownKeys": ["previous_hash"],
//     "missingRequired": [], "checkedAgainst": [ ...21 columns... ],
//     "scope": "column-level · schema-snapshot", "analyzed_at": "..." }
```

The verdict is a **schema-snapshot** check as of `analyzed_at` — names + presence
only, **not** a runtime or compiler guarantee. If the schema on disk may have changed
since startup, call `reanalyze` first, then re-check.

## Development

```bash
pnpm --filter @throughline/mcp start [repoPath]   # run the server (stdio)
pnpm --filter @throughline/mcp dev                # tsx watch
pnpm --filter @throughline/mcp test               # unit tests (node:test + tsx)
pnpm --filter @throughline/mcp verify [repoPath]  # end-to-end stdio verification

# Not in the root `pnpm typecheck` gate — run separately when touching this package:
pnpm --filter @throughline/mcp exec tsc -p tsconfig.json --noEmit
```
