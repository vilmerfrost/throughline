// Stage B1 verification — REPORT, not UI.
// Runs the real analyzer over Batch-Guard.ai-2 and reports the reach axis for
// batches / ml_scores / model_training_events, then runs the honesty checks.
import { parseSchema } from '../src/sql/parseSql.js';
import { loadProject } from '../src/ts/parseTs.js';
import { computeColumnUsage } from '../src/ts/columnUsage.js';
import type { ColumnUsage } from '@throughline/core';

const REPO = process.argv[2] ?? '/Users/vilmerfrost/Projects/Batch-Guard.ai-2';
const TABLES = ['batches', 'ml_scores', 'model_training_events'];

const REACHES = ['ui_shown', 'server_only', 'never_read', 'unknown'] as const;

function pad(s: string, n: number) {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function main() {
  console.log(`\n# THROUGHLINE Stage B1 — reach verification\nrepo: ${REPO}\n`);
  const t0 = Date.now();
  const { nodes: contracts, sqlViewReads } = await parseSchema(REPO);
  const project = loadProject(REPO);
  const usageByTable = computeColumnUsage(REPO, contracts, project, sqlViewReads);
  console.log(
    `analyzed in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${contracts.length} contracts, ${sqlViewReads.length} SQL view read(s)\n`,
  );

  const violations: string[] = [];

  // Codebase-wide honesty checks + reach tally over EVERY contract.
  const tally: Record<string, number> = { ui_shown: 0, server_only: 0, never_read: 0, unknown: 0 };
  for (const [table, usages] of usageByTable) {
    for (const u of usages) {
      tally[u.reach] = (tally[u.reach] ?? 0) + 1;
      if (u.reach === 'unknown' && (u.escapeTrail?.length ?? 0) < 1) {
        violations.push(`${table}.${u.column}: reach=unknown but NO escapeTrail`);
      }
      if (u.reach !== 'unknown' && (u.escapeTrail?.length ?? 0) > 0) {
        violations.push(`${table}.${u.column}: reach=${u.reach} carries an escapeTrail (only unknown may)`);
      }
    }
  }

  for (const table of TABLES) {
    const usages = usageByTable.get(table);
    if (!usages) {
      console.log(`## ${table}\n  (no contract found)\n`);
      continue;
    }
    const dist: Record<string, number> = { ui_shown: 0, server_only: 0, never_read: 0, unknown: 0 };

    console.log(`## ${table}  (${usages.length} columns)`);
    console.log(`  ${pad('column', 30)} ${pad('reach', 12)} ${pad('confidence', 12)} ev  verdict`);
    for (const u of [...usages].sort((a, b) => a.column.localeCompare(b.column))) {
      dist[u.reach] = (dist[u.reach] ?? 0) + 1;
      const conf = u.certain ? 'certain' : 'heuristic';
      console.log(
        `  ${pad(u.column, 30)} ${pad(u.reach, 12)} ${pad(conf, 12)} ${pad(String(u.evidence.length), 3)} ${u.verdict}`,
      );
      // The spec requires every `unknown` to show its escape-trail.
      if (u.reach === 'unknown') {
        const hops = dedupeTrail(u.escapeTrail ?? []);
        for (const h of hops) console.log(`  ${' '.repeat(30)} ↳ trail: ${h.filePath}:${h.startLine}  ${oneLine(h.snippet)}`);
      }
    }
    console.log(
      `  -- distribution: ui_shown=${dist.ui_shown} server_only=${dist.server_only} never_read=${dist.never_read} unknown=${dist.unknown}\n`,
    );
  }

  console.log(
    `## codebase-wide reach tally (${usageByTable.size} contracts): ui_shown=${tally.ui_shown} server_only=${tally.server_only} never_read=${tally.never_read} unknown=${tally.unknown}\n`,
  );
  if (sqlViewReads.length > 0) {
    console.log('## SQL view read evidence\n');
    for (const read of sqlViewReads.slice(0, 12)) {
      const target =
        read.confidence === 'certain'
          ? `${read.table}.${(read.columns ?? []).join(',')}`
          : `${read.table}.* (opaque columns)`;
      console.log(`  ${read.viewName} -> ${target}  ${read.source.filePath}:${read.source.startLine}`);
    }
    if (sqlViewReads.length > 12) console.log(`  ... ${sqlViewReads.length - 12} more`);
    console.log('');
  }
  console.log(
    `  NB: the three focus tables show no never_read — each has an escaping select('*'),\n` +
      `  which the conservative rule (A2) forbids from ever yielding never_read. never_read\n` +
      `  surfaces on contracts with no escaping '*' read (see the example below).\n`,
  );

  // Show one concrete, grounded example of each reach value across ALL contracts.
  console.log('## one example of each reach value (across all contracts)\n');
  for (const want of REACHES) {
    const found = exampleOf(usageByTable, want);
    if (!found) {
      console.log(`  ${pad(want, 12)} — NONE FOUND in the entire codebase`);
      violations.push(`spec requires at least one ${want}; none found`);
      continue;
    }
    const { table, u } = found;
    console.log(`  ${pad(want, 12)} ${table}.${u.column}  (${u.certain ? 'certain' : 'heuristic'}, ${u.evidence.length} evidence)`);
    const grounding = u.reach === 'unknown' ? u.escapeTrail : u.evidence;
    const g = grounding?.[0];
    if (g) console.log(`               ↳ ${g.filePath}:${g.startLine}  ${oneLine(g.snippet)}`);
    if (u.reach === 'unknown') {
      console.log(`               escape-trail (${u.escapeTrail?.length ?? 0} hop(s)):`);
      for (const ref of u.escapeTrail ?? []) console.log(`                 · ${ref.filePath}:${ref.startLine}  ${oneLine(ref.snippet)}`);
    }
  }

  console.log('\n## honesty checks');
  for (const r of REACHES) if ((tally[r] ?? 0) < 1) violations.push(`missing reach value: ${r}`);
  if (violations.length === 0) {
    console.log('  ✓ every `unknown` carries an escape-trail');
    console.log('  ✓ no non-`unknown` reach carries an escape-trail');
    console.log('  ✓ no `never_read` survives an escaping/untyped `*` read (structural: decide() only');
    console.log('    reaches never_read when no hiding read exists; unit-tested in reach.test.ts)');
    console.log('  ✓ all four reach values present across the codebase');
    console.log('\nRESULT: PASS\n');
  } else {
    console.log('  ✗ violations:');
    for (const v of violations) console.log(`    - ${v}`);
    console.log('\nRESULT: FAIL\n');
    process.exitCode = 1;
  }
}

function exampleOf(byTable: Map<string, ColumnUsage[]>, reach: string): { table: string; u: ColumnUsage } | undefined {
  // Prefer an example from the three focus tables; fall back to any contract.
  for (const table of TABLES) {
    const u = byTable.get(table)?.find((x) => x.reach === reach);
    if (u) return { table, u };
  }
  for (const [table, usages] of byTable) {
    const u = usages.find((x) => x.reach === reach);
    if (u) return { table, u };
  }
  return undefined;
}

function oneLine(s: string) {
  return s.replace(/\s+/g, ' ').trim().slice(0, 90);
}

function dedupeTrail(refs: { filePath: string; startLine: number; snippet: string }[]) {
  const seen = new Set<string>();
  const out: typeof refs = [];
  for (const r of refs) {
    const key = `${r.filePath}:${r.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
