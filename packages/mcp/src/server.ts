import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GraphCache } from './graphCache.js';
import {
  THROUGHLINE_AGENT_INSTRUCTIONS,
  aboutThroughline,
  getTableFacts,
  getFileFacts,
  getNodeContext,
  getRootCauseFacts,
  checkWrite,
} from './facts.js';

const sourceScopeSchema = z.enum(['production', 'test', 'migration', 'script', 'generated', 'unknown', 'all']);

// Wrap a structured object as an MCP tool result: machine-readable
// structuredContent + a text mirror for clients that ignore it.
function ok(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

// Builds the MCP server. Every tool is READ-ONLY: it reads the cached graph and
// returns grounded facts. No tool sets, overrides, or marks a verdict. The only
// tool that changes facts is reanalyze(), which re-derives them from disk.
export function createServer(cache: GraphCache): McpServer {
  const server = new McpServer(
    { name: 'throughline', version: '0.1.0' },
    { instructions: THROUGHLINE_AGENT_INSTRUCTIONS },
  );

  server.registerResource(
    'about_throughline',
    'throughline://about',
    {
      title: 'About Throughline',
      description:
        'How agents should use Throughline: target selection, trust tiers, schemaMatch, analyzer limits, and read-only guarantees.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(aboutThroughline(), null, 2),
          mimeType: 'application/json',
        },
      ],
    }),
  );

  server.registerTool(
    'about_throughline',
    {
      title: 'About Throughline',
      description:
        'Read-only onboarding for connected agents: explains the contract-centric model, trust tiers, schemaMatch vs trust, analyzer depth limits, recommended workflow, and grounded/read-only guarantees.',
      inputSchema: {},
    },
    async () => ok(aboutThroughline()),
  );

  server.registerTool(
    'get_analysis_target',
    {
      title: 'Get current analyzed repo target',
      description:
        'Read-only status for the in-memory MCP graph cache: current absolute repo path, how it was resolved (argv/env/default/runtime), analyzed_at, readiness, graph counts, warnings, and workflow hints. Call this first from an agent workspace.',
      inputSchema: {},
    },
    async () => ok(cache.getAnalysisTarget()),
  );

  server.registerTool(
    'set_analysis_target',
    {
      title: 'Point analysis at a different local repo',
      description:
        'Repoints only the MCP cache target. Validates the path exists and is a directory, rebuilds facts from disk with buildGraph, and swaps the cached graph only after success. It never accepts agent-supplied verdicts or graph fragments.',
      inputSchema: {
        path: z.string().describe('Absolute or relative path to the local repo/workspace to analyze'),
        reason: z.string().optional().describe('Optional caller note explaining why the target changed'),
      },
    },
    async ({ path, reason }) => ok(await cache.setAnalysisTarget({ path, reason })),
  );

  server.registerTool(
    'get_table',
    {
      title: 'Get table contract facts',
      description:
        'Read-only. Contract facts for a table (bare name): columns with type/nullable/default and read reach (+escapeTrail), writer/reader touches with trust or schemaMatch and the analyzer reason, drift findings, and declared FK neighbors with cardinality and external flag. Carries confidence, scope, analyzed_at, and real source grounding. Cannot change any verdict.',
      inputSchema: {
        name: z.string().describe('Bare table name, e.g. "batches"'),
        scope: sourceScopeSchema.optional().describe('Optional source-scope filter. Defaults to all.'),
        includeTests: z.boolean().optional().describe('Set false to exclude test touches while keeping other scopes.'),
      },
    },
    async ({ name, scope, includeTests }) => ok(getTableFacts(name, cache.graph, { scope, includeTests })),
  );

  server.registerTool(
    'get_file',
    {
      title: 'Get all touches in a file',
      description:
        'Read-only. Every data-contract touch in a file (path relative to the repo root, or absolute under it): each touch with its trust/schemaMatch verdict, the analyzer reason, nodeId, source snippet, direction, and the tables it touches. Entry point when editing a file. Carries confidence, scope, analyzed_at. Cannot change any verdict.',
      inputSchema: {
        path: z.string().describe('File path relative to the repo root'),
        scope: sourceScopeSchema.optional().describe('Optional source-scope filter. Defaults to all.'),
        includeTests: z.boolean().optional().describe('Set false to exclude test touches while keeping other scopes.'),
      },
    },
    async ({ path, scope, includeTests }) => ok(getFileFacts(path, cache.graph, { scope, includeTests })),
  );

  server.registerTool(
    'get_node_context',
    {
      title: 'Drill into one touch',
      description:
        'Read-only. Full context for one touch by nodeId: its trust/schemaMatch, analyzer reason, source snippet (file:line), the contract it touches (columns + reach), and immediate neighbors (sibling touches on the same contract + FK neighbors). Carries confidence, scope, analyzed_at. Cannot change any verdict.',
      inputSchema: { nodeId: z.string().describe('A touch node id, e.g. "touch:ts:src/x.ts:42:batches"') },
    },
    async ({ nodeId }) => ok(getNodeContext(nodeId, cache.graph)),
  );

  server.registerTool(
    'get_root_causes',
    {
      title: 'Get ranked root-cause levers',
      description:
        'Read-only. The deterministic root-cause rollup: dark/asserted touches grouped by (reason, client origin), ranked biggest-lever-first. Each lever has affectedCount, affected touch ids and contracts, the unresolved shape (e.g. parameter), and real grounding evidence. Carries analyzed_at. Cannot change any verdict.',
      inputSchema: {
        scope: sourceScopeSchema.optional().describe('Optional source-scope filter. Defaults to all.'),
        includeTests: z.boolean().optional().describe('Set false to exclude test touches while keeping other scopes.'),
      },
    },
    async ({ scope, includeTests }) => ok(getRootCauseFacts(cache.graph, { scope, includeTests })),
  );

  server.registerTool(
    'check_write',
    {
      title: 'Check a proposed write against the schema (preventive)',
      description:
        'Pure evaluation — changes NOTHING (no verdict moves, nothing recorded, analyzed_at untouched). Validate a PROPOSED insert/update BEFORE writing the code: compares field NAMES against the table columns (presence + unknown keys only — does NOT type-check values). insert flags NOT-NULL-without-default columns that are missing (missingRequired) plus unknown keys; update flags only unknown keys (partial writes are fine). Verdict is would_align / would_mismatch as of analyzed_at — a schema-snapshot check, NOT a runtime or compiler guarantee; call reanalyze() first if the schema may be stale. Unknown table → no verdict, never fabricated. Reuses the same comparison as the Rust write analyzer.',
      inputSchema: {
        table: z.string().describe('Bare table name, e.g. "events_log"'),
        fields: z.array(z.string()).describe('Proposed field names the write would set'),
        verb: z.enum(['insert', 'update']).describe('insert (full row) or update (partial)'),
      },
    },
    async ({ table, fields, verb }) => ok(checkWrite(table, fields, verb, cache.graph)),
  );

  server.registerTool(
    'reanalyze',
    {
      title: 'Re-derive all facts from disk',
      description:
        'Re-runs the analyzer on the current code on disk and replaces the cached graph. Returns the fresh analyzed_at, the previous analyzed_at, current counts, and per-field deltas. This is the ONLY way a verdict moves — green is re-earned by changing code, never asserted.',
      inputSchema: {},
    },
    async () => ok(await cache.reanalyze()),
  );

  return server;
}
