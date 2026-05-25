import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { GraphEdge, GraphNode, Language, SourceRef, WriterLifecycle } from '@throughline/core';
import { detectDrift, summarizeDrift } from './detect.js';

function contract(table: string): GraphNode {
  return {
    id: `contract:${table}`,
    kind: 'contract',
    label: table,
    source: { language: 'sql', filePath: 'supabase/migrations/001_init.sql', startLine: 1, endLine: 1, snippet: `create table ${table} ()` },
  };
}

function source(filePath: string): SourceRef {
  return { language: 'typescript', filePath, startLine: 1, endLine: 1, snippet: 'touch' };
}

function touch(
  id: string,
  label: string,
  sourceScope: GraphNode['sourceScope'],
  opts: { language?: Language; trust?: GraphNode['trust']; lifecycle?: WriterLifecycle } = {},
): GraphNode {
  const language = opts.language ?? 'typescript';
  return {
    id,
    kind: 'touch',
    label,
    language,
    trust: opts.trust ?? 'dark',
    trustReason: opts.trust === 'verified' ? 'ts-verified' : 'ts-loose-client',
    sourceScope,
    lifecycle: opts.lifecycle,
    source: source(sourceScope === 'test' ? 'tests/x.test.ts' : 'app/x.ts'),
  };
}

test('test-only dark writes are labelled as test-only info instead of production risk', () => {
  const contracts = [contract('adapter_runs')];
  const touches = [touch('touch:test', 'write adapter_runs', 'test')];
  const edges: GraphEdge[] = [
    { id: 'edge:test', source: 'touch:test', target: 'contract:adapter_runs', direction: 'write' },
  ];

  const [finding] = detectDrift(contracts, touches, edges);
  assert.equal(finding.testOnly, true);
  assert.equal(finding.productionImpact, false);
  assert.deepEqual(finding.scopeBreakdown, { test: 1 });
  assert.match(finding.message, /Test-only/);
});

test('production dark writes keep productionImpact true with scope breakdown', () => {
  const contracts = [contract('adapter_runs')];
  const touches = [touch('touch:prod', 'write adapter_runs', 'production')];
  const edges: GraphEdge[] = [
    { id: 'edge:prod', source: 'touch:prod', target: 'contract:adapter_runs', direction: 'write' },
  ];

  const [finding] = detectDrift(contracts, touches, edges);
  assert.equal(finding.testOnly, false);
  assert.equal(finding.productionImpact, true);
  assert.deepEqual(finding.scopeBreakdown, { production: 1 });
  assert.match(finding.message, /Every directly traced runtime write/);
});

test('read/write asymmetry findings also carry scope metadata', () => {
  const contracts = [contract('adapter_runs')];
  const touches = [touch('touch:test', 'write adapter_runs', 'test', { trust: 'verified' })];
  const edges: GraphEdge[] = [
    { id: 'edge:test', source: 'touch:test', target: 'contract:adapter_runs', direction: 'write' },
  ];

  const [finding] = detectDrift(contracts, touches, edges);
  assert.equal(finding.testOnly, true);
  assert.equal(finding.productionImpact, false);
  assert.deepEqual(finding.scopeBreakdown, { test: 1 });
});

test('all-dark-writes finding carries kind/fixability/recommendedAction', () => {
  const contracts = [contract('adapter_runs')];
  const touches = [touch('touch:prod', 'write adapter_runs', 'production')];
  const edges: GraphEdge[] = [
    { id: 'edge:prod', source: 'touch:prod', target: 'contract:adapter_runs', direction: 'write' },
  ];

  const [finding] = detectDrift(contracts, touches, edges);
  assert.equal(finding.kind, 'all-dark-writes');
  assert.equal(finding.fixability, 'actionable');
  assert.match(finding.recommendedAction ?? '', /SupabaseClient<Database>/);
});

test('migration-lifecycle writers do not feed the all-dark-writes category', () => {
  // A SQL migration backfill writes to a table — that does NOT make the table
  // "written by app code". The verified TS reader keeps the contract typed,
  // so the only finding should be informational asymmetry-no-writer is NOT
  // emitted (there IS a writer) — we expect NO finding at all.
  const contracts = [contract('adapter_runs')];
  const touches = [
    touch('touch:mig', 'write adapter_runs', 'migration', {
      language: 'typescript', // language doesn't matter; lifecycle does
      lifecycle: 'migration',
    }),
    touch('touch:read', 'read adapter_runs', 'production', { trust: 'verified' }),
  ];
  const edges: GraphEdge[] = [
    { id: 'edge:mig', source: 'touch:mig', target: 'contract:adapter_runs', direction: 'write' },
    { id: 'edge:read', source: 'touch:read', target: 'contract:adapter_runs', direction: 'read' },
  ];

  const findings = detectDrift(contracts, touches, edges);
  // No runtime writer → no all-dark-writes; reader is verified → no asymmetry
  // either (we don't fire asymmetry-no-writer when migration writers exist).
  assert.equal(findings.length, 0);
});

test('cross-language blind boundary only fires for runtime shallow writers', () => {
  // A Python migration write doesn't make the table "blind at runtime". A
  // shallow runtime Python writer + TS reader DOES.
  const contracts = [contract('events')];
  const migOnly: GraphNode[] = [
    touch('touch:mig', 'write events', 'migration', { language: 'python', lifecycle: 'migration' }),
    touch('touch:ts', 'read events', 'production', { trust: 'verified' }),
  ];
  const migEdges: GraphEdge[] = [
    { id: 'e:mig', source: 'touch:mig', target: 'contract:events', direction: 'write' },
    { id: 'e:ts', source: 'touch:ts', target: 'contract:events', direction: 'read' },
  ];
  assert.equal(detectDrift(contracts, migOnly, migEdges).length, 0);

  const runtime: GraphNode[] = [
    touch('touch:py', 'write events', 'production', { language: 'python' }),
    touch('touch:ts', 'read events', 'production', { trust: 'verified' }),
  ];
  const runEdges: GraphEdge[] = [
    { id: 'e:py', source: 'touch:py', target: 'contract:events', direction: 'write' },
    { id: 'e:ts', source: 'touch:ts', target: 'contract:events', direction: 'read' },
  ];
  const [finding] = detectDrift(contracts, runtime, runEdges);
  assert.equal(finding.kind, 'cross-language-blind-boundary');
  assert.equal(finding.fixability, 'requires-investigation');
});

test('summarizeDrift rolls up severity/kind/fixability/impact counts', () => {
  const contracts = [contract('a'), contract('b'), contract('c')];
  const touches: GraphNode[] = [
    touch('t:a', 'write a', 'production'),
    touch('t:b', 'write b', 'test'),
  ];
  const edges: GraphEdge[] = [
    { id: 'e:a', source: 't:a', target: 'contract:a', direction: 'write' },
    { id: 'e:b', source: 't:b', target: 'contract:b', direction: 'write' },
  ];
  const findings = detectDrift(contracts, touches, edges);
  const summary = summarizeDrift(findings);
  assert.equal(summary.total, findings.length);
  // c gets an untouched-contract finding; a + b get all-dark-writes.
  assert.equal(summary.byKind['all-dark-writes'], 2);
  assert.equal(summary.byKind['untouched-contract'], 1);
  assert.equal(summary.bySeverity.info, 3);
  assert.equal(summary.byFixability.actionable, 2);
  assert.equal(summary.byFixability.informational, 1);
  assert.equal(summary.productionImpact, 1);
  assert.equal(summary.testOnly, 1);
});
