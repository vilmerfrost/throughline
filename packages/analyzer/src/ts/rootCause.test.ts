import { strict as assert } from 'node:assert';
import test from 'node:test';
import { Node, Project, SyntaxKind } from 'ts-morph';
import type { GraphNode, SourceRef, TrustReason } from '@throughline/core';
import {
  rollupRootCauses,
  resolveClientOrigin,
  classifyUnresolved,
  type RootCauseInput,
} from './rootCause.js';
import { parseTs } from './parseTs.js';

// ---------------------------------------------------------------------------
// rollupRootCauses — PURE deterministic grouping. No ts-morph, no inference.
// Given per-touch facts (id, reason, contract, resolved origin) it groups by
// (reason, origin) and ranks biggest-lever-first.
// ---------------------------------------------------------------------------

function src(filePath: string, startLine: number): SourceRef {
  return { language: 'typescript', filePath, startLine, endLine: startLine, snippet: 'const sb = createServerClient()' };
}

function input(
  touchId: string,
  reason: TrustReason,
  contract: string,
  originName: string,
  origin?: SourceRef,
): RootCauseInput {
  return { touchId, reason, contract, origin: { name: originName, source: origin } };
}

test('touches sharing (reason, origin construction site) roll up into one root cause', () => {
  const site = src('lib/supabase.ts', 5);
  const causes = rollupRootCauses([
    input('t1', 'ts-loose-client', 'batches', 'createServerClient', site),
    input('t2', 'ts-loose-client', 'ml_scores', 'createServerClient', site),
  ]);

  assert.equal(causes.length, 1);
  assert.equal(causes[0].reason, 'ts-loose-client');
  assert.equal(causes[0].origin.name, 'createServerClient');
  assert.equal(causes[0].origin.source?.filePath, 'lib/supabase.ts');
  assert.equal(causes[0].affectedCount, 2);
  assert.deepEqual(causes[0].affectedTouchIds, ['t1', 't2']);
  assert.deepEqual(causes[0].affectedContracts, ['batches', 'ml_scores']);
});

test('same origin but different reason → separate root causes', () => {
  const site = src('lib/supabase.ts', 5);
  const causes = rollupRootCauses([
    input('t1', 'ts-loose-client', 'batches', 'createServerClient', site),
    input('t2', 'ts-cast-concrete', 'batches', 'createServerClient', site),
  ]);
  assert.equal(causes.length, 2);
});

test('same reason + same name but different construction site → separate root causes', () => {
  const causes = rollupRootCauses([
    input('t1', 'ts-loose-client', 'batches', 'createServerClient', src('a.ts', 1)),
    input('t2', 'ts-loose-client', 'batches', 'createServerClient', src('b.ts', 9)),
  ]);
  assert.equal(causes.length, 2);
});

test('root causes are ranked biggest-lever-first by affectedCount', () => {
  const big = src('lib/big.ts', 1);
  const small = src('lib/small.ts', 1);
  const causes = rollupRootCauses([
    input('t1', 'ts-loose-client', 'batches', 'createAdminClient', small),
    input('t2', 'ts-loose-client', 'batches', 'createServerClient', big),
    input('t3', 'ts-loose-client', 'ml_scores', 'createServerClient', big),
    input('t4', 'ts-loose-client', 'events', 'createServerClient', big),
  ]);
  assert.equal(causes[0].origin.name, 'createServerClient');
  assert.equal(causes[0].affectedCount, 3);
  assert.equal(causes[1].affectedCount, 1);
});

test('affectedContracts is deduped and sorted; affectedCount counts touches not contracts', () => {
  const site = src('lib/supabase.ts', 5);
  const causes = rollupRootCauses([
    input('t1', 'ts-loose-client', 'ml_scores', 'createServerClient', site),
    input('t2', 'ts-loose-client', 'batches', 'createServerClient', site),
    input('t3', 'ts-loose-client', 'batches', 'createServerClient', site),
  ]);
  assert.equal(causes[0].affectedCount, 3);
  assert.deepEqual(causes[0].affectedContracts, ['batches', 'ml_scores']);
});

test('unresolved origins are grouped separately by reason with no invented source', () => {
  const causes = rollupRootCauses([
    input('t1', 'ts-loose-client', 'batches', 'unresolved-origin'),
    input('t2', 'ts-loose-client', 'ml_scores', 'unresolved-origin'),
    input('t3', 'ts-cast-any', 'batches', 'unresolved-origin'),
  ]);
  const loose = causes.find((c) => c.reason === 'ts-loose-client' && c.origin.name === 'unresolved-origin');
  assert.ok(loose);
  assert.equal(loose!.affectedCount, 2);
  assert.equal(loose!.origin.source, undefined);
  assert.equal(causes.filter((c) => c.origin.name === 'unresolved-origin').length, 2);
});

// ---------------------------------------------------------------------------
// resolveClientOrigin — follow the .from() receiver's symbol to its construction
// site via ts-morph. Honest: unresolved when it can't trace to a construction.
// ---------------------------------------------------------------------------

function fromCallIn(code: string) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { jsx: 4 } });
  const sf = project.createSourceFile('src/fixture.ts', code);
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (Node.isPropertyAccessExpression(expr) && expr.getName() === 'from') return call;
  }
  throw new Error('no .from() call in fixture');
}

test('local const client built by a helper → resolves to the construction site + helper name', () => {
  const code = `
    function createServerClient() { return {} as any; }
    function load() {
      const sb = createServerClient();
      return sb.from('batches').select('*');
    }
  `;
  const origin = resolveClientOrigin(fromCallIn(code), '/repo');
  assert.equal(origin.name, 'createServerClient');
  assert.ok(origin.source);
  assert.match(origin.source!.snippet, /createServerClient\(\)/);
});

test('awaited construction is unwrapped to the helper', () => {
  const code = `
    async function createServerClient() { return {} as any; }
    async function load() {
      const sb = await createServerClient();
      return sb.from('batches').select('*');
    }
  `;
  const origin = resolveClientOrigin(fromCallIn(code), '/repo');
  assert.equal(origin.name, 'createServerClient');
});

test('inline construction (.from chained directly off the factory call) resolves', () => {
  const code = `
    function createAdminClient() { return {} as any; }
    function load() {
      return createAdminClient().from('batches').select('*');
    }
  `;
  const origin = resolveClientOrigin(fromCallIn(code), '/repo');
  assert.equal(origin.name, 'createAdminClient');
  assert.ok(origin.source);
});

test('client passed in as a parameter cannot be traced → unresolved-origin, no source', () => {
  const code = `
    function load(sb: any) {
      return sb.from('batches').select('*');
    }
  `;
  const origin = resolveClientOrigin(fromCallIn(code), '/repo');
  assert.equal(origin.name, 'unresolved-origin');
  assert.equal(origin.source, undefined);
});

test('method call on a client (e.g. .schema()) traces through to the underlying construction', () => {
  const code = `
    function createServerClient() { return {} as any; }
    function load() {
      const sb = createServerClient();
      return sb.schema('public').from('batches').select('*');
    }
  `;
  const origin = resolveClientOrigin(fromCallIn(code), '/repo');
  assert.equal(origin.name, 'createServerClient');
});

// ---------------------------------------------------------------------------
// Integration — parseTs exposes a rolled-up rootCauses array covering exactly
// the dark/asserted TS touches.
// ---------------------------------------------------------------------------

test('parseTs rolls up dark touches that share a constructed client', async () => {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { jsx: 4 } });
  project.createSourceFile(
    'src/app.ts',
    `
      function createServerClient() { return {} as any; }
      async function a() {
        const sb = createServerClient();
        return sb.from('batches').select('*');
      }
      async function b() {
        const sb = createServerClient();
        return sb.from('ml_scores').select('*');
      }
    `,
  );
  const contracts: GraphNode[] = [
    { id: 'contract:batches', kind: 'contract', label: 'batches', language: 'sql' },
    { id: 'contract:ml_scores', kind: 'contract', label: 'ml_scores', language: 'sql' },
  ];
  const result = await parseTs('/repo', contracts, project);
  // both touches are dark (loose client). Two separate construction sites.
  const loose = result.rootCauses.filter((c) => c.reason === 'ts-loose-client');
  assert.ok(loose.length >= 1);
  const total = result.rootCauses.reduce((n, c) => n + c.affectedCount, 0);
  const darkAsserted = result.nodes.filter((n) => n.trust === 'dark' || n.trust === 'asserted').length;
  assert.equal(total, darkAsserted);
});

// ---------------------------------------------------------------------------
// classifyUnresolved — WHY an unresolved touch can't be traced. Structural and
// deterministic; 'other' whenever unsure.
// ---------------------------------------------------------------------------

function multiFileFromCall(files: Record<string, string>, entry: string) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { jsx: 4 } });
  for (const [name, code] of Object.entries(files)) project.createSourceFile(name, code);
  const sf = project.getSourceFileOrThrow(entry);
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (Node.isPropertyAccessExpression(expr) && expr.getName() === 'from') return call;
  }
  throw new Error('no .from() call in entry file');
}

test('client passed as a parameter → shape "parameter" with a real signature SourceRef', () => {
  const code = `
    import type { SupabaseClient } from '@supabase/supabase-js';
    async function loadTier(admin: SupabaseClient, id: string) {
      return admin.from('batches').select('*');
    }
  `;
  const c = classifyUnresolved(fromCallIn(code), '/repo');
  assert.equal(c.shape, 'parameter');
  assert.ok(c.evidence, 'parameter shape must capture a signature ref');
  assert.match(c.evidence!.snippet, /admin\s*:\s*SupabaseClient/);
});

test('ref/closure indirection (supabaseRef.current) → shape "ref"', () => {
  const code = `
    function useThing(supabaseRef: any) {
      const supabase = supabaseRef.current;
      return supabase.from('batches').select('*');
    }
  `;
  const c = classifyUnresolved(fromCallIn(code), '/repo');
  assert.equal(c.shape, 'ref');
  assert.equal(c.evidence, undefined);
});

test('direct .current access on a ref → shape "ref"', () => {
  const code = `
    function useThing(supabaseRef: any) {
      return supabaseRef.current.from('batches').select('*');
    }
  `;
  assert.equal(classifyUnresolved(fromCallIn(code), '/repo').shape, 'ref');
});

test('imported singleton untyped at its definition → shape "imported-untyped"', () => {
  const call = multiFileFromCall(
    {
      'src/lib/client.ts': `
        declare const globalThing: any;
        export const supabase: any = globalThing;
      `,
      'src/page.ts': `
        import { supabase } from './lib/client';
        export function load() {
          return supabase.from('batches').select('*');
        }
      `,
    },
    'src/page.ts',
  );
  assert.equal(classifyUnresolved(call, '/repo').shape, 'imported-untyped');
});

test('uncategorizable indirection → shape "other" (never guess)', () => {
  const code = `
    function load(clients: any[]) {
      return clients[0].from('batches').select('*');
    }
  `;
  assert.equal(classifyUnresolved(fromCallIn(code), '/repo').shape, 'other');
});

// ---------------------------------------------------------------------------
// rollup sub-groups unresolved origins by shape, with capped evidence.
// ---------------------------------------------------------------------------

function unresolvedInput(
  touchId: string,
  reason: TrustReason,
  contract: string,
  shape: 'parameter' | 'ref' | 'imported-untyped' | 'other',
  evidence?: SourceRef,
): RootCauseInput {
  return { touchId, reason, contract, origin: { name: 'unresolved-origin', shape }, evidence };
}

test('unresolved touches are sub-grouped by shape', () => {
  const sig = src('app/lib/feature-flags.ts', 83);
  const causes = rollupRootCauses([
    unresolvedInput('t1', 'ts-loose-client', 'batches', 'parameter', sig),
    unresolvedInput('t2', 'ts-loose-client', 'ml_scores', 'parameter', sig),
    unresolvedInput('t3', 'ts-loose-client', 'events', 'ref'),
  ]);
  const param = causes.find((c) => c.origin.shape === 'parameter');
  const ref = causes.find((c) => c.origin.shape === 'ref');
  assert.ok(param && ref);
  assert.equal(param!.affectedCount, 2);
  assert.equal(ref!.affectedCount, 1);
  // origin.source stays absent for unresolved — the signature lives in evidence.
  assert.equal(param!.origin.source, undefined);
  assert.ok(param!.evidence && param!.evidence.length >= 1);
});

test('evidence is capped and deduped per unresolved group', () => {
  const inputs: RootCauseInput[] = [];
  for (let i = 0; i < 10; i++) {
    inputs.push(unresolvedInput(`t${i}`, 'ts-loose-client', 'batches', 'parameter', src(`f${i}.ts`, 1)));
  }
  // two touches sharing one signature must not double the evidence entry
  inputs.push(unresolvedInput('dup', 'ts-loose-client', 'batches', 'parameter', src('f0.ts', 1)));
  const cause = rollupRootCauses(inputs).find((c) => c.origin.shape === 'parameter')!;
  assert.equal(cause.affectedCount, 11);
  assert.ok(cause.evidence!.length <= 3, 'evidence sample is capped');
  const keys = cause.evidence!.map((e) => `${e.filePath}:${e.startLine}`);
  assert.equal(new Set(keys).size, keys.length, 'evidence is deduped');
});
