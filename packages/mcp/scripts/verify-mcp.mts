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

  const expected = ['check_write', 'get_file', 'get_node_context', 'get_root_causes', 'get_table', 'reanalyze'];
  expected.every((e: string) => names.includes(e))
    ? pass('all six read-only/pure tools registered')
    : fail(`missing tools; got ${names.join(', ')}`);

  const carriesAnalyzedAt = (o: any, label: string) =>
    typeof o.analyzed_at === 'string'
      ? pass(`${label} carries analyzed_at`)
      : fail(`${label} missing analyzed_at`);

  // These tables MUST exist in Batch-Guard.ai-2. A missing expected table is a
  // hard FAIL — never a silent skip. Skipping is the test-harness version of the
  // exact false-green this tool exists to prevent.
  const requiredTables = ['events_log', 'batches', 'inspection_packs'];
  const tables: Record<string, any> = {};
  for (const name of requiredTables) {
    const r = structured(await client.callTool({ name: 'get_table', arguments: { name } }));
    tables[name] = r;
    if (!r.found) {
      fail(`get_table(${name}) expected table is ABSENT (found:false) — regression or wrong name`);
      continue;
    }
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

  // Named case 1 — events_log: the Rust insert writes an unknown key `previous_hash`
  // not in the schema. This must surface as a drift finding grounded in a real
  // SourceRef (it is NOT folded into any verdict; it stays a free-form-payload mismatch).
  {
    const r = tables['events_log'];
    const hashDrift = (r?.drift ?? []).find(
      (d: any) =>
        /previous_hash/.test(d.message) &&
        /unknown key|not in the schema/i.test(d.message),
    );
    hashDrift &&
    typeof hashDrift.source?.filePath === 'string' &&
    typeof hashDrift.source?.startLine === 'number'
      ? pass(
          `events_log: previous_hash unknown-key mismatch present @ ${hashDrift.source.filePath}:${hashDrift.source.startLine}`,
        )
      : fail('events_log: previous_hash unknown-key mismatch drift (with SourceRef) NOT found');
  }

  // Named case 2 — batches: the BatchInsertPayload Rust write resolves field-by-field
  // against the schema and returns schemaMatch 'aligned' at deep-parsed scope (Stage 1a).
  {
    const r = tables['batches'];
    const alignedRust = (r?.touches?.writers ?? []).find(
      (w: any) =>
        w.schemaMatch === 'aligned' && w.language === 'rust' && w.scope?.depth === 'deep',
    );
    alignedRust && typeof alignedRust.source?.filePath === 'string'
      ? pass(
          `batches: BatchInsertPayload aligned deep-parsed Rust write present @ ${alignedRust.source.filePath}:${alignedRust.source.startLine} (schemaMatch=aligned)`,
        )
      : fail('batches: no aligned deep-parsed Rust write (BatchInsertPayload, schemaMatch=aligned) found');
  }

  // --- check_write — preventive, PURE. Must change NOTHING. -----------------
  // Capture analyzed_at BEFORE any check_write call; re-read it AFTER to prove
  // the tool mutated nothing.
  const analyzedAtBefore = tables['batches'].analyzed_at;
  const cw = (table: string, fields: string[], verb: 'insert' | 'update') =>
    client
      .callTool({ name: 'check_write', arguments: { table, fields, verb } })
      .then(structured);

  // Named case A — events_log: a write that includes the real columns PLUS the
  // bogus `previous_hash` key must be caught preventively as would_mismatch with
  // previous_hash in unknownKeys. This is the exact bug check_write exists to stop.
  {
    const realCols = (tables['events_log'].columns ?? []).map((c: any) => c.name);
    const r = await cw('events_log', [...realCols, 'previous_hash'], 'insert');
    r.verdict === 'would_mismatch' && (r.unknownKeys ?? []).includes('previous_hash')
      ? pass(`check_write(events_log, +previous_hash, insert) → would_mismatch, unknownKeys⊇[previous_hash]`)
      : fail(`check_write(events_log,+previous_hash) expected would_mismatch w/ previous_hash; got ${JSON.stringify(r.verdict)} unknownKeys=${JSON.stringify(r.unknownKeys)}`);
    // Honest framing: grounded in real columns, schema-snapshot scope, never 'verified'.
    Array.isArray(r.checkedAgainst) && r.checkedAgainst.length > 0 &&
    r.scope === 'column-level · schema-snapshot' &&
    typeof r.analyzed_at === 'string' &&
    !/verified/i.test(JSON.stringify(r))
      ? pass(`check_write carries checkedAgainst(${r.checkedAgainst.length}) + scope + analyzed_at, no 'verified' claim`)
      : fail(`check_write(events_log) missing grounding/scope/analyzed_at or overclaims 'verified': ${JSON.stringify(r)}`);
  }

  // Named case B — batches: writing the table's full column set on insert aligns.
  {
    const allCols = (tables['batches'].columns ?? []).map((c: any) => c.name);
    const r = await cw('batches', allCols, 'insert');
    r.verdict === 'would_align' && (r.unknownKeys ?? []).length === 0 && (r.missingRequired ?? []).length === 0
      ? pass(`check_write(batches, all columns, insert) → would_align`)
      : fail(`check_write(batches, all cols) expected would_align; got ${JSON.stringify(r.verdict)} missing=${JSON.stringify(r.missingRequired)} unknown=${JSON.stringify(r.unknownKeys)}`);
  }

  // Named case C — batches: omitting a NOT-NULL-without-default column is a
  // mismatch on insert (missingRequired lists it) but ALIGNS as an update
  // (partial writes are fine). A schema with no such column is a hard FAIL — the
  // spec asserts this case exists; a silent skip would be a false green.
  {
    const cols = tables['batches'].columns ?? [];
    const required = cols.filter((c: any) => c.nullable === false && !c.hasDefault);
    if (required.length === 0) {
      fail('check_write(batches): no NOT-NULL-without-default column exists to exercise missingRequired — schema regression or wrong target');
    } else {
      const omit = required[0].name;
      const partial = cols.map((c: any) => c.name).filter((n: string) => n !== omit);
      const ins = await cw('batches', partial, 'insert');
      ins.verdict === 'would_mismatch' && (ins.missingRequired ?? []).includes(omit)
        ? pass(`check_write(batches, omit NOT-NULL \`${omit}\`, insert) → would_mismatch, missingRequired⊇[${omit}]`)
        : fail(`check_write(batches, omit ${omit}, insert) expected would_mismatch listing ${omit}; got ${JSON.stringify(ins.verdict)} missing=${JSON.stringify(ins.missingRequired)}`);
      const upd = await cw('batches', partial, 'update');
      upd.verdict === 'would_align'
        ? pass(`check_write(batches, same partial, update) → would_align (partial writes are fine)`)
        : fail(`check_write(batches, partial, update) expected would_align; got ${JSON.stringify(upd.verdict)}`);
    }
  }

  // Named case D — batches: omitting ONLY a NOT-NULL-WITH-default column on insert
  // still aligns (the default fills it).
  {
    const cols = tables['batches'].columns ?? [];
    const defaulted = cols.filter((c: any) => c.nullable === false && c.hasDefault);
    if (defaulted.length === 0) {
      fail('check_write(batches): no NOT-NULL-with-default column exists to exercise the default-covers-it rule — schema regression or wrong target');
    } else {
      const omit = defaulted[0].name;
      const fields = cols.map((c: any) => c.name).filter((n: string) => n !== omit);
      const r = await cw('batches', fields, 'insert');
      r.verdict === 'would_align'
        ? pass(`check_write(batches, omit defaulted \`${omit}\`, insert) → would_align (default covers it)`)
        : fail(`check_write(batches, omit defaulted ${omit}) expected would_align; got ${JSON.stringify(r.verdict)} missing=${JSON.stringify(r.missingRequired)}`);
    }
  }

  // Named case E — unknown table: say so, NO fabricated verdict.
  {
    const r = await cw('nonexistent_table', ['anything'], 'insert');
    r.found === false && r.verdict === undefined
      ? pass(`check_write(nonexistent_table) → found:false, no fabricated verdict`)
      : fail(`check_write(nonexistent_table) expected found:false & no verdict; got found=${r.found} verdict=${JSON.stringify(r.verdict)}`);
  }

  // Invariant — check_write is PURE: analyzed_at is UNCHANGED after all the calls.
  {
    const after = structured(await client.callTool({ name: 'get_table', arguments: { name: 'batches' } })).analyzed_at;
    after === analyzedAtBefore
      ? pass(`check_write mutated nothing: analyzed_at unchanged (${after})`)
      : fail(`check_write mutated state: analyzed_at ${analyzedAtBefore} -> ${after}`);
  }

  const rc = structured(await client.callTool({ name: 'get_root_causes', arguments: {} }));
  carriesAnalyzedAt(rc, 'get_root_causes');
  rc.rootCauses.length > 0
    ? pass(`get_root_causes returned ${rc.rootCauses.length} levers; top affectedCount=${rc.rootCauses[0].affectedCount}`)
    : fail('get_root_causes returned no levers');
  const paramLever = rc.rootCauses.find((l: any) => l.origin?.shape === 'parameter');
  if (!paramLever) {
    fail('parameter-shape root-cause lever (query.ts) is ABSENT');
  } else {
    paramLever.affectedCount === 20
      ? pass(`query.ts parameter lever present: affectedCount=20`)
      : fail(`parameter lever affectedCount=${paramLever.affectedCount}, expected 20`);
    const ev = paramLever.evidence?.[0]?.filePath ?? '';
    /query\.ts/.test(ev)
      ? pass(`parameter lever grounded in query.ts (${ev})`)
      : fail(`parameter lever evidence not grounded in query.ts: "${ev}"`);
  }

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
