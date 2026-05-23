import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'src', 'index.ts');
const REPO = process.env.THROUGHLINE_REPO || '/Users/vilmerfrost/Projects/Batch-Guard.ai-2';

// Resolve tsx binary: prefer workspace-local bin, fall back to PATH.
function resolveTsx(): { command: string; args: string[] } {
  // Try the local node_modules/.bin/tsx first (relative to this script's package).
  const localTsx = path.join(here, '..', 'node_modules', '.bin', 'tsx');
  try {
    // createRequire just lets us resolve; we use localTsx as the command directly.
    return { command: localTsx, args: [entry, REPO] };
  } catch {
    // Fall back: node with --import tsx
    return { command: process.execPath, args: ['--import', 'tsx', entry, REPO] };
  }
}

function structured(res: any): any {
  return res.structuredContent ?? JSON.parse(res.content?.[0]?.text ?? '{}');
}

async function main() {
  const { command, args } = resolveTsx();
  console.error(`[verify-mcp] spawning: ${command} ${args.join(' ')}`);

  const transport = new StdioClientTransport({ command, args });
  const client = new Client({ name: 'verify-mcp', version: '0.0.0' });
  await client.connect(transport);

  const checks: string[] = [];
  const fail = (m: string) => {
    console.error('FAIL:', m);
    checks.push(`FAIL ${m}`);
  };
  const pass = (m: string) => {
    console.error('ok:  ', m);
    checks.push(`ok   ${m}`);
  };

  // Honesty invariant: no tool can mutate a verdict — none should exist.
  const { tools } = await client.listTools();
  const names = tools.map((t: any) => t.name).sort();
  console.error('tools:', names.join(', '));
  const mutators = names.filter((n: string) =>
    /set|mark|resolve|fix|override|update|verify|assert|mutate/i.test(n),
  );
  mutators.length === 0
    ? pass('no verdict-mutating tool exists')
    : fail(`found mutating-looking tool(s): ${mutators.join(', ')}`);

  const expected = ['get_file', 'get_node_context', 'get_root_causes', 'get_table', 'reanalyze'];
  expected.every((e: string) => names.includes(e))
    ? pass('all five read-only tools registered')
    : fail(`missing tools; got ${names.join(', ')}`);

  const carriesAnalyzedAt = (o: any, label: string) =>
    typeof o.analyzed_at === 'string'
      ? pass(`${label} carries analyzed_at`)
      : fail(`${label} missing analyzed_at`);

  for (const name of ['audit_log', 'batches', 'inspection_packs']) {
    const r = structured(await client.callTool({ name: 'get_table', arguments: { name } }));
    if (r.found) {
      carriesAnalyzedAt(r, `get_table(${name})`);
      r.columns.length > 0 ? pass(`get_table(${name}) has columns`) : fail(`get_table(${name}) no columns`);
      const reachCols = r.columns.filter((c: any) => c.reach);
      pass(`get_table(${name}) reach on ${reachCols.length}/${r.columns.length} columns`);
      pass(`get_table(${name}) fkNeighbors=${r.fkNeighbors.length}, writers=${r.touches.writers.length}, readers=${r.touches.readers.length}`);
      const darkOrAsserted = [...r.touches.writers, ...r.touches.readers].filter(
        (t: any) => t.trust === 'dark' || t.trust === 'asserted',
      );
      darkOrAsserted.every((t: any) => t.reasonDescription && t.source)
        ? pass(`get_table(${name}) every dark/asserted touch carries reason + source`)
        : fail(`get_table(${name}) a dark/asserted touch lacks reason or source`);
    }
  }

  const rc = structured(await client.callTool({ name: 'get_root_causes', arguments: {} }));
  carriesAnalyzedAt(rc, 'get_root_causes');
  rc.rootCauses.length > 0
    ? pass(`get_root_causes returned ${rc.rootCauses.length} levers; top affectedCount=${rc.rootCauses[0].affectedCount}`)
    : fail('get_root_causes returned no levers');
  const paramLever = rc.rootCauses.find((l: any) => l.origin?.shape === 'parameter');
  paramLever
    ? pass(`parameter lever present: affectedCount=${paramLever.affectedCount}`)
    : console.error('note: no parameter-shape lever in this repo run');

  const evidencePath = paramLever?.evidence?.[0]?.filePath;
  if (evidencePath) {
    const f = structured(await client.callTool({ name: 'get_file', arguments: { path: evidencePath } }));
    carriesAnalyzedAt(f, `get_file(${evidencePath})`);
    pass(`get_file(${evidencePath}) found=${f.found}, touches=${f.touches?.length ?? 0}`);
    const firstNode = f.touches?.[0]?.nodeId;
    if (firstNode) {
      const ctx = structured(await client.callTool({ name: 'get_node_context', arguments: { nodeId: firstNode } }));
      carriesAnalyzedAt(ctx, 'get_node_context');
      ctx.node?.confidence && ctx.node?.scope
        ? pass(`get_node_context(${firstNode}) carries confidence + scope`)
        : fail('get_node_context missing confidence/scope');
    }
  }

  const re = structured(await client.callTool({ name: 'reanalyze', arguments: {} }));
  typeof re.analyzed_at === 'string' && re.previous_analyzed_at
    ? pass(`reanalyze: previous=${re.previous_analyzed_at} -> fresh=${re.analyzed_at}, deltas=${JSON.stringify(re.deltas)}`)
    : fail('reanalyze did not return fresh + previous analyzed_at');

  await client.close();

  const failures = checks.filter((c) => c.startsWith('FAIL'));
  console.error(`\n=== ${checks.length - failures.length}/${checks.length} checks passed ===`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error('verify-mcp fatal:', e);
  process.exit(1);
});
