#!/usr/bin/env tsx
import { buildGraph } from '@throughline/analyzer/buildGraph';

// repoPath comes from argv[2] or THROUGHLINE_REPO env; defaults to the
// verification repo so a bare launch is still useful.
function resolveRepoPath(): string {
  return (
    process.argv[2] ||
    process.env.THROUGHLINE_REPO ||
    '/Users/vilmerfrost/Projects/Batch-Guard.ai-2'
  );
}

async function main() {
  const repoPath = resolveRepoPath();
  console.error(`[throughline-mcp] analyzing ${repoPath} ...`);
  const graph = await buildGraph(repoPath);
  console.error(
    `[throughline-mcp] graph built: ${graph.nodes.length} nodes, ` +
      `${graph.edges.length} edges, analyzed_at=${graph.generatedAt}`,
  );
}

main().catch((error) => {
  console.error('[throughline-mcp] fatal:', error);
  process.exit(1);
});
