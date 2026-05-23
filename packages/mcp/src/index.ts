#!/usr/bin/env tsx
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GraphCache } from './graphCache.js';
import { createServer } from './server.js';

function resolveRepoPath(): string {
  return (
    process.argv[2] ||
    process.env.THROUGHLINE_REPO ||
    '/Users/vilmerfrost/Projects/Batch-Guard.ai-2'
  );
}

async function main() {
  const repoPath = resolveRepoPath();
  // Log to stderr ONLY — stdout is the MCP protocol channel.
  console.error(`[throughline-mcp] analyzing ${repoPath} ...`);
  const cache = new GraphCache(repoPath);
  await cache.init();
  console.error(
    `[throughline-mcp] ready: ${cache.graph.nodes.length} nodes, analyzed_at=${cache.graph.generatedAt}`,
  );

  const server = createServer(cache);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[throughline-mcp] connected on stdio');
}

main().catch((error) => {
  console.error('[throughline-mcp] fatal:', error);
  process.exit(1);
});
