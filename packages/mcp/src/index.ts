#!/usr/bin/env tsx
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GraphCache, type AnalysisTargetSource } from './graphCache.js';
import { createServer } from './server.js';

function resolveRepoPath(): { repoPath: string; resolvedFrom: AnalysisTargetSource } {
  if (process.argv[2]) return { repoPath: process.argv[2], resolvedFrom: 'argv' };
  if (process.env.THROUGHLINE_REPO) return { repoPath: process.env.THROUGHLINE_REPO, resolvedFrom: 'env' };
  return {
    repoPath: '/Users/vilmerfrost/Projects/Batch-Guard.ai-2',
    resolvedFrom: 'default',
  };
}

async function main() {
  const { repoPath, resolvedFrom } = resolveRepoPath();
  // Log to stderr ONLY — stdout is the MCP protocol channel.
  console.error(`[throughline-mcp] analyzing ${repoPath} ...`);
  const cache = new GraphCache(repoPath, undefined, resolvedFrom);
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
