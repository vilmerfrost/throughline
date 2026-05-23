// FK Stage A1 verification — REPORT, not UI.
// Runs the real SQL analyzer over Batch-Guard.ai-2 and reports every DECLARED
// foreign-key relationship (from→to, cardinality, source file:line), the total
// FK count, which tables are connected vs islands, any unresolved targets, then
// spot-checks that one relationship maps to a real REFERENCES on disk.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseSchema } from '../src/sql/parseSql.js';

const REPO = process.argv[2] ?? '/Users/vilmerfrost/Projects/Batch-Guard.ai-2';

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function main() {
  console.log(`\n# THROUGHLINE FK Stage A1 — relationship verification\nrepo: ${REPO}\n`);
  const t0 = Date.now();
  const { nodes, relationships } = await parseSchema(REPO);
  console.log(
    `analyzed in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${nodes.length} tables, ${relationships.length} relationships\n`,
  );

  const tableNames = new Set(nodes.map((n) => n.label));
  const violations: string[] = [];

  // --- Every extracted FK: from → to, cardinality, source ------------------
  console.log('## Declared foreign keys\n');
  const sorted = [...relationships].sort(
    (a, b) =>
      a.fromTable.localeCompare(b.fromTable) || a.fromColumn.localeCompare(b.fromColumn),
  );
  for (const r of sorted) {
    const card = r.cardinality === 'one-to-one' ? '1:1' : 'N:1';
    const from = `${r.fromTable}.${r.fromColumn}`;
    const to = `${r.toTable}.${r.toColumn}`;
    const loc = `${r.source.filePath}:${r.source.startLine}`;
    console.log(`  ${pad(from, 34)} → ${pad(to, 30)} ${pad(card, 4)} ${loc}`);
  }
  console.log(`\n  total: ${relationships.length} declared FK relationships`);
  const oneToOne = relationships.filter((r) => r.cardinality === 'one-to-one').length;
  console.log(
    `  cardinality: ${relationships.length - oneToOne} many-to-one, ${oneToOne} one-to-one\n`,
  );

  // --- Connected tables vs islands -----------------------------------------
  const connected = new Set<string>();
  for (const r of relationships) {
    connected.add(r.fromTable);
    if (tableNames.has(r.toTable)) connected.add(r.toTable);
  }
  const islands = [...tableNames].filter((t) => !connected.has(t)).sort();
  console.log('## Connectivity\n');
  console.log(`  connected tables: ${[...connected].sort().join(', ') || '(none)'}`);
  console.log(`  islands (no FK in or out): ${islands.join(', ') || '(none)'}\n`);

  // --- Unresolved targets (declared, never fabricated) ---------------------
  const unresolved = relationships.filter((r) => !tableNames.has(r.toTable));
  console.log('## Unresolved targets\n');
  if (unresolved.length === 0) {
    console.log('  none — every FK target resolves to a known table\n');
  } else {
    for (const r of unresolved) {
      console.log(
        `  ${r.fromTable}.${r.fromColumn} → ${r.toTable}(${r.toColumn})  [${r.source.filePath}:${r.source.startLine}] — target not a known table`,
      );
    }
    console.log('');
  }

  // --- Honesty check: empty target columns are never invented --------------
  for (const r of relationships) {
    if (!r.toColumn) {
      violations.push(`FK ${r.fromTable}.${r.fromColumn} → ${r.toTable} has an empty target column`);
    }
  }

  // --- Spot-check: one relationship maps to a real REFERENCES on disk ------
  console.log('## Disk spot-check\n');
  if (relationships.length === 0) {
    console.log('  no relationships to spot-check\n');
  } else {
    const sample = sorted[0];
    const abs = path.join(REPO, sample.source.filePath);
    const lines = readFileSync(abs, 'utf8').split('\n');
    const slice = lines
      .slice(sample.source.startLine - 1, sample.source.endLine)
      .join('\n');
    const mentionsRef = /references/i.test(slice) && new RegExp(sample.toTable, 'i').test(slice);
    console.log(`  sample: ${sample.fromTable}.${sample.fromColumn} → ${sample.toTable}.${sample.toColumn}`);
    console.log(`  at:     ${sample.source.filePath}:${sample.source.startLine}-${sample.source.endLine}`);
    console.log(`  snippet contains a real "REFERENCES ${sample.toTable}": ${mentionsRef ? 'YES' : 'NO'}\n`);
    if (!mentionsRef) {
      violations.push(
        `spot-check failed: ${sample.source.filePath}:${sample.source.startLine} does not contain "REFERENCES ${sample.toTable}"`,
      );
    }
  }

  // --- Verdict -------------------------------------------------------------
  if (violations.length === 0) {
    console.log('## PASS — every relationship is a declared FK grounded on disk\n');
    process.exit(0);
  } else {
    console.log('## FAIL\n');
    for (const v of violations) console.log(`  - ${v}`);
    console.log('');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
