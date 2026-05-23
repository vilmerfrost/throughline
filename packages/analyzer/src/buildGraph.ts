import type { Graph } from '@throughline/core';
import { parseSchema } from './sql/parseSql.js';
import { loadProject, parseTs } from './ts/parseTs.js';
import { computeColumnUsage } from './ts/columnUsage.js';
import { grepShallow } from './shallow/grep.js';
import { analyzeRustWrites, attachSchemaMatch } from './rust/schemaMatch.js';
import { detectDrift } from './drift/detect.js';

// Compose the graph from the analyzers. Edges connect outputs from different
// analyzers: SQL contracts on one side, code touches on the other.
// Extracted verbatim from index.ts so consumers (the MCP server) can call it
// in-process without booting the Express server. Logic is unchanged.
export async function buildGraph(repoPath: string): Promise<Graph> {
  // FK-A1 (additive): one SQL pass yields both the contract nodes and the
  // declared FK relationships between them.
  const { nodes: sqlNodes, relationships } = await parseSchema(repoPath);
  // One ts-morph Project per run, shared by the TS analyzers (parseTs builds
  // touches; computeColumnUsage derives per-column read verdicts) so type
  // resolution is paid for once.
  const project = loadProject(repoPath);
  const [tsResult, shallowResult] = await Promise.all([
    parseTs(repoPath, sqlNodes, project),
    grepShallow(repoPath, sqlNodes),
  ]);
  const touches = [...tsResult.nodes, ...shallowResult.nodes];
  const edges = [...tsResult.edges, ...shallowResult.edges];

  // Additive, non-breaking: attach column-level read usage to contract nodes.
  const columnUsage = computeColumnUsage(repoPath, sqlNodes, project);
  for (const node of sqlNodes) {
    const usage = columnUsage.get(node.label);
    if (usage) node.columnUsage = usage;
  }

  // Stage 1a (ADDITIVE): deep-parse Rust writes and stamp a struct-vs-schema
  // `schemaMatch` verdict onto the (still-dark) Rust write touches, plus emit
  // grounded column-level drift findings. `trust` is deliberately left as-is.
  const rustWrites = await analyzeRustWrites(repoPath, sqlNodes);
  attachSchemaMatch(shallowResult.nodes, rustWrites);
  const rustDrift = rustWrites.flatMap((w) => w.drift);

  const nodes = [...sqlNodes, ...touches];

  return {
    repoPath,
    nodes,
    edges,
    drift: [...detectDrift(sqlNodes, touches, edges), ...rustDrift],
    // RC-a (additive): deterministic root-cause rollup of the dark/asserted TS
    // touches, ranked biggest-lever-first. Computed by the TS analyzer; nothing
    // else touched.
    rootCauses: tsResult.rootCauses,
    // FK-A1 (additive): declared foreign-key relationships, contract→contract.
    relationships,
    generatedAt: new Date().toISOString(),
  };
}
