// Client-type alias resolution — REPORT, not UI / not a unit test.
//
// The bug: a `.from()` whose client is typed THROUGH A TYPE ALIAS
// (`type AdminClient = SupabaseClient<Database>`) was reported `dark`
// (ts-loose-client) because the old detector matched the PRINTED type text —
// which shows the alias name `AdminClient`, containing neither "SupabaseClient"
// nor "Database". The fix resolves the receiver structurally (class symbol +
// first type argument), seeing through aliases and alias chains.
//
// The honest ground truth for "is this client typed?" is BEHAVIORAL: does
// `.from('table')` produce a schema-typed PostgrestQueryBuilder, or an `any` one?
// This report runs the analyzer's REAL `isTypedClient` over Batch-Guard.ai-2 and
// asserts it against that behavioral truth on every Supabase `.from()` call, then
// reports the production trust breakdown and the OLD→NEW delta.
//
// Two transitions, both CORRECT and both confirmed against behavioral truth:
//   • recovered  (OLD dark → NEW typed): genuine false-darks fixed — local
//     alias-typed clients whose `.from()` IS schema-typed (e.g. AdminClient).
//   • lie removed (OLD typed → NEW dark): the old text check blessed
//     `DatabaseSupabaseClient` because the *alias name* contains the substrings
//     "SupabaseClient" + "Database" — but it resolves to an intersection whose
//     bare arm reopens untyped access, so `.from()` is `any`. Verified was a lie;
//     dark is honest (and is exactly what the task asked for: the intersection
//     must NOT be verified).
import { Node, SyntaxKind, type CallExpression, type SourceFile } from 'ts-morph';
import { buildGraph } from '../src/buildGraph.js';
import { isTypedClient, loadProject } from '../src/ts/parseTs.js';

const REPO = process.argv[2] ?? '/Users/vilmerfrost/Projects/Batch-Guard.ai-2';
const EXCLUDE = /[/\\](node_modules|\.next|dist|out|build|\.turbo)[/\\]|\.d\.ts$/;

// --- OLD detector: text-only (the buggy version, for the delta) ------------
function oldIsTyped(receiver: Node): boolean {
  try {
    const text = receiver.getType().getText(receiver);
    if (!text.includes('SupabaseClient')) return false;
    if (/SupabaseClient<\s*any[,>]/.test(text)) return false;
    return text.includes('Database');
  } catch {
    return false;
  }
}

// --- Behavioral ground truth -----------------------------------------------
// `.from('t')` returns PostgrestQueryBuilder<ClientOpts, Schema, Relation, ...>.
// A genuinely-typed client carries a concrete Schema arg; a bare/loose client
// (incl. alias and intersection-with-bare-arm) yields `any`. null = the call is
// not a Supabase query builder (Array.from / Buffer.from / storage), so there's
// no ground truth to compare against.
function behaviorallyTyped(call: CallExpression): boolean | null {
  const rt = call.getReturnType();
  if (rt.getSymbol()?.getName() !== 'PostgrestQueryBuilder') return null;
  const args = rt.getTypeArguments();
  if (args.length < 2) return null;
  return !args[1].isAny();
}

function isFromCall(call: CallExpression): boolean {
  const expr = call.getExpression();
  return Node.isPropertyAccessExpression(expr) && expr.getName() === 'from';
}
function receiverOf(call: CallExpression): Node {
  return (call.getExpression() as ReturnType<typeof call.getExpression> & {
    getExpression(): Node;
  }).getExpression();
}
function fromCalls(sf: SourceFile): CallExpression[] {
  return sf.getDescendantsOfKind(SyntaxKind.CallExpression).filter(isFromCall);
}

async function main() {
  console.log(`\n# THROUGHLINE — client-type alias resolution verification\nrepo: ${REPO}\n`);
  const violations: string[] = [];

  // --- 1. Production trust breakdown (real buildGraph output) --------------
  const t0 = Date.now();
  const graph = await buildGraph(REPO);
  const tsTouches = graph.nodes.filter((n) => n.kind === 'touch' && n.language === 'typescript');
  const byTrust = new Map<string, number>();
  for (const n of tsTouches) byTrust.set(n.trust ?? '?', (byTrust.get(n.trust ?? '?') ?? 0) + 1);
  console.log(`analyzed in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${tsTouches.length} TS touches\n`);
  console.log('## Production TS touch trust breakdown (fixed)\n');
  for (const [trust, count] of [...byTrust].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${trust.padEnd(10)} ${count}`);
  }

  // --- 2. Production isTypedClient vs behavioral ground truth --------------
  // The core honesty guarantee: isTypedClient must NEVER disagree with what the
  // compiler actually did to the query result.
  const project = loadProject(REPO);
  let agree = 0;
  let disagree = 0;
  let recovered = 0; // OLD loose → NEW typed (false-dark fixed)
  let lieRemoved = 0; // OLD typed → NEW loose (name-coincidence lie removed)
  const recoveredByFile = new Map<string, number>();
  const lieByFile = new Map<string, number>();
  const mismatches: string[] = [];
  for (const sf of project.getSourceFiles()) {
    if (EXCLUDE.test(sf.getFilePath())) continue;
    for (const call of fromCalls(sf)) {
      const recv = receiverOf(call);
      let nu: boolean;
      try {
        nu = isTypedClient(call);
      } catch {
        continue;
      }
      const truth = behaviorallyTyped(call);
      const rel = sf.getFilePath().replace(REPO + '/', '');
      if (truth !== null) {
        if (nu === truth) agree += 1;
        else {
          disagree += 1;
          if (mismatches.length < 20)
            mismatches.push(`${rel}:${call.getStartLineNumber()} isTypedClient=${nu} behavioral=${truth}`);
        }
      }
      const ol = oldIsTyped(recv);
      if (!ol && nu) {
        recovered += 1;
        recoveredByFile.set(rel, (recoveredByFile.get(rel) ?? 0) + 1);
      }
      if (ol && !nu) {
        lieRemoved += 1;
        lieByFile.set(rel, (lieByFile.get(rel) ?? 0) + 1);
      }
    }
  }
  console.log('\n## isTypedClient vs behavioral ground truth (every Supabase `.from()`)\n');
  console.log(`  agree=${agree}  disagree=${disagree}`);
  if (disagree > 0) {
    violations.push(`isTypedClient disagrees with behavioral truth on ${disagree} call(s)`);
    for (const m of mismatches) console.log(`    MISMATCH ${m}`);
  } else {
    console.log('  isTypedClient NEVER lies: matches the real query-builder result on every call.');
  }

  // --- 3. OLD → NEW delta --------------------------------------------------
  console.log('\n## OLD (text-only) → NEW (structural) delta\n');
  console.log(`  recovered  (false-dark fixed: OLD dark → NEW typed): ${recovered}`);
  for (const [f, n] of [...recoveredByFile].sort((a, b) => b[1] - a[1])) console.log(`      +${n}  ${f}`);
  console.log(`  lie removed (OLD verified-by-name → NEW dark):        ${lieRemoved}`);
  for (const [f, n] of [...lieByFile].sort((a, b) => b[1] - a[1]).slice(0, 8))
    console.log(`      -${n}  ${f}`);
  if ([...lieByFile].length > 8) console.log(`      … ${[...lieByFile].length - 8} more files`);

  // --- 4. Named spot-checks (correct, behavioral-truth expectations) -------
  console.log('\n## Named receiver spot-checks (real repo, no app edits)\n');
  type Case = { label: string; want: boolean; match: (sf: SourceFile) => boolean };
  const cases: Case[] = [
    {
      label: 'local alias AdminClient (render-batch / phase-2-sidecars) → TYPED (recovered)',
      want: true,
      match: (sf) => /inspection-packs\/(render-batch|phase-2-sidecars)\.ts$/.test(sf.getFilePath()),
    },
    {
      // The REAL `DatabaseSupabaseClient = SupabaseClient<Database>` is genuinely
      // typed (full type-check: its `.from().select().data` is the typed Row), so
      // it resolves to TYPED. NOTE: this is NOT the task's hypothetical bare-first
      // intersection `SupabaseClient & SupabaseClient<Database>` — that genuinely
      // reopens untyped access and stays DARK; it doesn't occur in this repo and
      // is pinned by the unit test instead.
      label: 'DatabaseSupabaseClient (= SupabaseClient<Database>) → TYPED',
      want: true,
      match: (sf) => /\.tsx?$/.test(sf.getFilePath()),
    },
    {
      label: 'bare SupabaseClient (feature-flags) → DARK',
      want: false,
      match: (sf) => /feature-flags\.ts$/.test(sf.getFilePath()),
    },
  ];
  // For the spot-checks we restrict to receivers of the named alias and to calls
  // that ARE Supabase query builders (have a ground truth).
  const tally = cases.map(() => ({ typed: 0, loose: 0 }));
  for (const sf of project.getSourceFiles()) {
    if (EXCLUDE.test(sf.getFilePath())) continue;
    for (const call of fromCalls(sf)) {
      if (behaviorallyTyped(call) === null) continue; // not a Supabase builder
      const recvText = receiverOf(call).getType().getText(receiverOf(call));
      const nu = isTypedClient(call);
      cases.forEach((c, i) => {
        const named =
          c.label.startsWith('DatabaseSupabaseClient')
            ? recvText.endsWith('DatabaseSupabaseClient')
            : c.match(sf);
        if (!named) return;
        if (nu) tally[i].typed += 1;
        else tally[i].loose += 1;
      });
    }
  }
  cases.forEach((c, i) => {
    const b = tally[i];
    const total = b.typed + b.loose;
    const ok = total > 0 && (c.want ? b.loose === 0 : b.typed === 0);
    console.log(`  [${ok ? 'OK ' : '!! '}] ${c.label}  (typed=${b.typed} loose=${b.loose})`);
    if (!ok)
      violations.push(total === 0 ? `no receivers for: ${c.label}` : `spot-check failed: ${c.label}`);
  });

  // --- Verdict --------------------------------------------------------------
  console.log('\n## Verdict\n');
  if (violations.length === 0) {
    console.log(
      `  PASS — isTypedClient matches behavioral truth on all ${agree} Supabase calls; ` +
        `${recovered} false-dark recovered, ${lieRemoved} name-coincidence lie(s) removed, spot-checks clean.`,
    );
  } else {
    console.log(`  FAIL — ${violations.length} violation(s):`);
    for (const v of violations) console.log(`    - ${v}`);
    process.exitCode = 1;
  }
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
