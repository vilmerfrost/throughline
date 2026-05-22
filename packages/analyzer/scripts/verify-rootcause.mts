// RC-a verification — REPORT, not UI.
// Runs the real TS analyzer over Batch-Guard.ai-2 and reports the deterministic
// root-cause rollup of dark/asserted touches, then runs the honesty checks:
//   - top root causes by count, each with its origin file:line
//   - counts sum to total dark/asserted touches (resolved + unresolved)
//   - spot-check that one resolved origin is a real construction site on disk
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseSql } from '../src/sql/parseSql.js';
import { loadProject, parseTs } from '../src/ts/parseTs.js';
import { UNRESOLVED_ORIGIN } from '../src/ts/rootCause.js';

const REPO = process.argv[2] ?? '/Users/vilmerfrost/Projects/Batch-Guard.ai-2';

function pad(s: string, n: number) {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function oneLine(s: string) {
  return s.replace(/\s+/g, ' ').trim().slice(0, 80);
}

async function main() {
  console.log(`\n# THROUGHLINE RC-a — root-cause rollup verification\nrepo: ${REPO}\n`);
  const t0 = Date.now();
  const contracts = await parseSql(REPO);
  const project = loadProject(REPO);
  const { nodes, rootCauses } = await parseTs(REPO, contracts, project);
  console.log(`analyzed in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${contracts.length} contracts\n`);

  const darkAsserted = nodes.filter((n) => n.trust === 'dark' || n.trust === 'asserted');
  const violations: string[] = [];

  // -- top root causes ------------------------------------------------------
  console.log(`## root causes (${rootCauses.length}), ranked biggest-lever-first\n`);
  console.log(`  ${pad('#', 4)}${pad('touches', 9)}${pad('reason', 22)}${pad('via', 26)}origin`);
  rootCauses.forEach((rc, i) => {
    const via = rc.origin.name;
    const loc = rc.origin.source ? `${rc.origin.source.filePath}:${rc.origin.source.startLine}` : '(unresolved)';
    console.log(`  ${pad(String(i + 1), 4)}${pad(String(rc.affectedCount), 9)}${pad(rc.reason, 22)}${pad(via, 26)}${loc}`);
  });
  console.log();

  // -- spell out the biggest few with their contracts ----------------------
  console.log('## biggest levers (with affected contracts)\n');
  for (const rc of rootCauses.filter((r) => r.origin.name !== UNRESOLVED_ORIGIN).slice(0, 5)) {
    const loc = rc.origin.source ? `${rc.origin.source.filePath}:${rc.origin.source.startLine}` : '?';
    console.log(`  • ${rc.reason} via ${rc.origin.name} → ${rc.affectedCount} touches`);
    console.log(`      origin: ${loc}`);
    if (rc.origin.source) console.log(`      ↳ ${oneLine(rc.origin.source.snippet)}`);
    console.log(`      contracts: ${rc.affectedContracts.join(', ')}`);
  }
  console.log();

  // -- conservation check ---------------------------------------------------
  const resolved = rootCauses.filter((r) => r.origin.name !== UNRESOLVED_ORIGIN);
  const unresolved = rootCauses.filter((r) => r.origin.name === UNRESOLVED_ORIGIN);
  const resolvedCount = resolved.reduce((n, r) => n + r.affectedCount, 0);
  const unresolvedCount = unresolved.reduce((n, r) => n + r.affectedCount, 0);
  const total = resolvedCount + unresolvedCount;

  console.log('## conservation\n');
  console.log(`  dark/asserted TS touches:       ${darkAsserted.length}`);
  console.log(`  explained by resolved origins:  ${resolvedCount}`);
  console.log(`  unresolved-origin (separate):   ${unresolvedCount}`);
  console.log(`  sum:                            ${total}\n`);
  if (total !== darkAsserted.length) {
    violations.push(`rollup counts (${total}) != dark/asserted touches (${darkAsserted.length})`);
  }

  // -- unresolved broken down by shape -------------------------------------
  const SHAPES = ['parameter', 'ref', 'imported-untyped', 'other'] as const;
  const byShape: Record<string, number> = { parameter: 0, ref: 0, 'imported-untyped': 0, other: 0 };
  for (const rc of unresolved) byShape[rc.origin.shape ?? 'other'] += rc.affectedCount;

  console.log('## unresolved-origin by shape\n');
  for (const shape of SHAPES) {
    console.log(`  ${pad(shape, 18)}${byShape[shape]}`);
  }
  const shapeSum = SHAPES.reduce((n, s) => n + byShape[s], 0);
  console.log(`  ${pad('sum', 18)}${shapeSum}\n`);
  if (shapeSum !== unresolvedCount) {
    violations.push(`shape breakdown (${shapeSum}) != unresolved total (${unresolvedCount})`);
  }
  // Every unresolved root cause must carry a shape; none may invent a source.
  for (const rc of unresolved) {
    if (!rc.origin.shape) violations.push(`unresolved root cause without a shape (${rc.reason})`);
    if (rc.origin.source) violations.push(`unresolved root cause carries a source (${rc.reason})`);
  }

  // -- show a couple real parameter signatures -----------------------------
  console.log('## "parameter" shape — real signatures to fix\n');
  const paramGroups = unresolved
    .filter((r) => r.origin.shape === 'parameter')
    .sort((a, b) => b.affectedCount - a.affectedCount);
  let shownSigs = 0;
  let sigDiskChecked = false;
  for (const rc of paramGroups) {
    for (const ev of rc.evidence ?? []) {
      if (shownSigs >= 4) break;
      console.log(`  • ${ev.filePath}:${ev.startLine}  (${rc.reason}, ${rc.affectedCount} touches in group)`);
      console.log(`      ${oneLine(ev.snippet)}`);
      // Spot-check the first signature actually exists on disk as claimed.
      if (!sigDiskChecked) {
        sigDiskChecked = true;
        try {
          const diskLine = readFileSync(path.join(REPO, ev.filePath), 'utf8').split('\n')[ev.startLine - 1] ?? '';
          const head = oneLine(ev.snippet.split('\n')[0]).slice(0, 20);
          if (head && oneLine(diskLine).includes(head)) {
            console.log(`      ✓ signature verified on disk`);
          } else {
            violations.push(`parameter signature does not match disk at ${ev.filePath}:${ev.startLine}`);
          }
        } catch {
          violations.push(`parameter signature file not found on disk: ${ev.filePath}`);
        }
      }
      shownSigs += 1;
    }
    if (shownSigs >= 4) break;
  }
  if (byShape.parameter > 0 && shownSigs === 0) {
    violations.push('parameter-shaped touches exist but no signature evidence was captured');
  }
  console.log();

  // every touch id must be unique across all root causes (no double-count)
  const seen = new Set<string>();
  for (const rc of rootCauses) {
    for (const id of rc.affectedTouchIds) {
      if (seen.has(id)) violations.push(`touch ${id} appears in more than one root cause`);
      seen.add(id);
    }
  }

  // ranking must be non-increasing by count
  for (let i = 1; i < rootCauses.length; i++) {
    if (rootCauses[i].affectedCount > rootCauses[i - 1].affectedCount) {
      violations.push('root causes are not ranked biggest-first');
      break;
    }
  }

  // -- spot-check one resolved origin is a REAL construction site -----------
  console.log('## spot-check: one resolved origin is a real construction site\n');
  const sample = resolved.find((r) => r.origin.source);
  if (!sample || !sample.origin.source) {
    violations.push('no resolved origin with a source to spot-check');
  } else {
    const { filePath, startLine, snippet } = sample.origin.source;
    const abs = path.join(REPO, filePath);
    let fileLine = '';
    try {
      fileLine = readFileSync(abs, 'utf8').split('\n')[startLine - 1] ?? '';
    } catch {
      violations.push(`origin file not found on disk: ${filePath}`);
    }
    console.log(`  origin:   ${sample.origin.name}  (${sample.affectedCount} touches)`);
    console.log(`  at:       ${filePath}:${startLine}`);
    console.log(`  analyzer: ${oneLine(snippet)}`);
    console.log(`  on disk:  ${oneLine(fileLine)}`);
    // The snippet's first real line should match what's actually on disk.
    const snippetHead = oneLine(snippet.split('\n')[0]);
    if (fileLine && !oneLine(fileLine).includes(snippetHead.slice(0, 20))) {
      violations.push(`spot-check: analyzer snippet does not match disk at ${filePath}:${startLine}`);
    }
    // and the helper name must literally appear at that construction site
    if (snippet.includes(sample.origin.name)) {
      console.log(`  ✓ helper name \`${sample.origin.name}\` is literally present at the site`);
    } else {
      violations.push(`origin name ${sample.origin.name} not present in its own construction snippet`);
    }
  }

  console.log('\n## honesty checks');
  for (const rc of rootCauses) {
    if (rc.affectedCount !== rc.affectedTouchIds.length) {
      violations.push(`affectedCount != affectedTouchIds.length for ${rc.reason}/${rc.origin.name}`);
    }
    if (rc.origin.name === UNRESOLVED_ORIGIN && rc.origin.source) {
      violations.push(`unresolved-origin must not carry a source (${rc.reason})`);
    }
  }

  if (violations.length === 0) {
    console.log('  ✓ rollup counts conserve the dark/asserted touch total');
    console.log('  ✓ no touch is double-counted across root causes');
    console.log('  ✓ root causes ranked biggest-lever-first');
    console.log('  ✓ resolved origin verified against real source on disk');
    console.log('  ✓ unresolved origins carry no invented source');
    console.log('  ✓ every unresolved origin carries a shape; breakdown conserves the total');
    console.log('  ✓ parameter-shape signatures verified against real source on disk');
    console.log('\nRESULT: PASS\n');
  } else {
    console.log('  ✗ violations:');
    for (const v of violations) console.log(`    - ${v}`);
    console.log('\nRESULT: FAIL\n');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
