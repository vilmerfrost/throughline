import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleGraph } from './__fixtures__/sampleGraph.js';
import { depthForNode, confidenceForNode, touchFact, fkNeighbors, getTableFacts } from './facts.js';

test('depthForNode: typescript touch is deep', () => {
  const ts = sampleGraph.nodes.find((n) => n.id.startsWith('touch:ts'))!;
  assert.equal(depthForNode(ts), 'deep');
});

test('depthForNode: python touch is shallow', () => {
  const py = sampleGraph.nodes.find((n) => n.id.startsWith('touch:python'))!;
  assert.equal(depthForNode(py), 'shallow');
});

test('confidenceForNode: deep -> certain, shallow -> heuristic', () => {
  const ts = sampleGraph.nodes.find((n) => n.id.startsWith('touch:ts'))!;
  const py = sampleGraph.nodes.find((n) => n.id.startsWith('touch:python'))!;
  assert.equal(confidenceForNode(ts), 'certain');
  assert.equal(confidenceForNode(py), 'heuristic');
});

test('touchFact: carries nodeId, trust, reason text, confidence, scope, source', () => {
  const py = sampleGraph.nodes.find((n) => n.id.startsWith('touch:python'))!;
  const f = touchFact(py);
  assert.equal(f.nodeId, 'touch:python:scripts/seed.py:3:batches');
  assert.equal(f.trust, 'dark');
  assert.equal(f.trustReason, 'shallow-grep-python');
  assert.match(f.reasonDescription, /Python is shallow-grep only/);
  assert.equal(f.confidence, 'heuristic');
  assert.deepEqual(f.scope, { level: 'table', depth: 'shallow' });
  assert.equal(f.sourceScope, 'script');
  assert.equal(f.source?.filePath, 'scripts/seed.py');
});

test('fkNeighbors: outbound FK to a non-contract table is flagged external', () => {
  const ns = fkNeighbors('batches', sampleGraph);
  assert.equal(ns.length, 1);
  assert.equal(ns[0].direction, 'references');
  assert.equal(ns[0].toTable, 'orgs');
  assert.equal(ns[0].cardinality, 'many-to-one');
  assert.equal(ns[0].external, true); // orgs has no contract node in the fixture
});

test('getTableFacts: found table reports columns with reach, touches, drift, fk', () => {
  const t = getTableFacts('batches', sampleGraph);
  assert.equal(t.found, true);
  assert.equal(t.analyzed_at, '2026-05-23T12:00:00.000Z');

  const spice = t.columns.find((c) => c.name === 'spice_density')!;
  assert.equal(spice.reach, 'ui_shown');
  assert.equal(spice.reachConfidence, 'certain');

  const recipe = t.columns.find((c) => c.name === 'recipe')!;
  assert.equal(recipe.reach, 'unknown');
  assert.equal(recipe.reachConfidence, 'heuristic');
  assert.equal(recipe.escapeTrail?.length, 1);

  assert.equal(t.touches.writers.length, 1);
  assert.equal(t.touches.writers[0].trust, 'dark');
  assert.equal(t.touches.readers.length, 1);
  assert.equal(t.touches.readers[0].trust, 'verified');

  assert.equal(t.drift.length, 1);
  assert.equal(t.fkNeighbors.length, 1);
  assert.equal(t.scope.level, 'table');
});

test('getTableFacts: scope filter excludes other touches and reports excluded counts', () => {
  const t = getTableFacts('batches', sampleGraph, { scope: 'production' });
  assert.equal(t.touches.readers.length, 1);
  assert.equal(t.touches.writers.length, 0);
  assert.deepEqual(t.excludedTouches, { script: 1 });
});

test('getTableFacts: all scope groups touches by source scope', () => {
  const t = getTableFacts('batches', sampleGraph, { scope: 'all' });
  assert.deepEqual(Object.keys(t.touchesByScope ?? {}).sort(), ['production', 'script']);
  assert.equal(t.touchesByScope?.production?.readers.length, 1);
  assert.equal(t.touchesByScope?.script?.writers.length, 1);
});

test('getTableFacts: unknown table returns found:false but still carries analyzed_at', () => {
  const t = getTableFacts('does_not_exist', sampleGraph);
  assert.equal(t.found, false);
  assert.equal(t.analyzed_at, '2026-05-23T12:00:00.000Z');
});

import { getFileFacts } from './facts.js';

test('getFileFacts: relative path returns its touches with tables touched', () => {
  const f = getFileFacts('scripts/seed.py', sampleGraph);
  assert.equal(f.found, true);
  assert.equal(f.touches.length, 1);
  assert.equal(f.touches[0].nodeId, 'touch:python:scripts/seed.py:3:batches');
  assert.deepEqual(f.touches[0].tablesTouched, ['batches']);
  assert.equal(f.touches[0].direction, 'write');
});

test('getFileFacts: scope filter can exclude a file touch', () => {
  const f = getFileFacts('scripts/seed.py', sampleGraph, { scope: 'production' });
  assert.equal(f.found, false);
  assert.equal(f.touches.length, 0);
});

test('getFileFacts: absolute path under repoPath is normalized', () => {
  const f = getFileFacts('/repo/src/ui/Batch.tsx', sampleGraph);
  assert.equal(f.found, true);
  assert.equal(f.touches[0].direction, 'read');
});

test('getFileFacts: unknown file returns found:false with analyzed_at', () => {
  const f = getFileFacts('nope.ts', sampleGraph);
  assert.equal(f.found, false);
  assert.equal(f.analyzed_at, '2026-05-23T12:00:00.000Z');
});

import { getNodeContext } from './facts.js';

test('getNodeContext: a touch drills into trust, contract, and neighbors', () => {
  const ctx = getNodeContext('touch:ts:src/ui/Batch.tsx:10:batches', sampleGraph);
  assert.equal(ctx.found, true);
  assert.equal(ctx.node?.trust, 'verified');
  assert.equal(ctx.node?.confidence, 'certain');
  assert.equal(ctx.contract?.table, 'batches');
  assert.ok(ctx.contract?.columns.some((c) => c.name === 'spice_density'));
  // sibling = the python writer on the same contract, excluding self
  assert.equal(ctx.neighbors.siblingTouches.length, 1);
  assert.equal(ctx.neighbors.siblingTouches[0].nodeId, 'touch:python:scripts/seed.py:3:batches');
  assert.equal(ctx.neighbors.fkNeighbors.length, 1);
});

test('getNodeContext: unknown nodeId returns found:false with analyzed_at', () => {
  const ctx = getNodeContext('touch:ts:nope:1:x', sampleGraph);
  assert.equal(ctx.found, false);
  assert.equal(ctx.analyzed_at, '2026-05-23T12:00:00.000Z');
});

import { checkWrite } from './facts.js';

test('checkWrite: insert with only optional/defaulted columns present → would_align', () => {
  // batches: id is NOT NULL but has a default; recipe/spice_density are nullable.
  const r = checkWrite('batches', ['recipe', 'spice_density'], 'insert', sampleGraph);
  assert.equal(r.found, true);
  assert.equal(r.verdict, 'would_align');
  assert.deepEqual(r.missingRequired, []);
  assert.deepEqual(r.unknownKeys, []);
  assert.deepEqual(r.checkedAgainst, ['id', 'recipe', 'spice_density']);
  assert.equal(r.scope, 'column-level · schema-snapshot');
  assert.equal(r.analyzed_at, '2026-05-23T12:00:00.000Z');
  // Never claims runtime/compiler enforcement.
  assert.doesNotMatch(JSON.stringify(r), /verified/i);
});

test('checkWrite: unknown key → would_mismatch listing it (names only)', () => {
  const r = checkWrite('batches', ['recipe', 'previous_hash'], 'insert', sampleGraph);
  assert.equal(r.verdict, 'would_mismatch');
  assert.deepEqual(r.unknownKeys, ['previous_hash']);
  assert.deepEqual(r.missingRequired, []);
});

test('checkWrite: update never flags missing columns but still flags unknown keys', () => {
  const r = checkWrite('batches', ['recipe', 'bogus'], 'update', sampleGraph);
  assert.equal(r.verdict, 'would_mismatch');
  assert.deepEqual(r.unknownKeys, ['bogus']);
  assert.deepEqual(r.missingRequired, []);
});

test('checkWrite: unknown table → found:false, NO fabricated verdict, carries analyzed_at', () => {
  const r = checkWrite('not_a_table', ['x'], 'insert', sampleGraph);
  assert.equal(r.found, false);
  assert.equal(r.verdict, undefined);
  assert.deepEqual(r.checkedAgainst, []);
  assert.equal(r.analyzed_at, '2026-05-23T12:00:00.000Z');
});

test('checkWrite: PURE — does not mutate the graph (analyzed_at + node count unchanged)', () => {
  const at = sampleGraph.generatedAt;
  const count = sampleGraph.nodes.length;
  checkWrite('batches', ['recipe', 'previous_hash'], 'insert', sampleGraph);
  checkWrite('not_a_table', ['x'], 'update', sampleGraph);
  assert.equal(sampleGraph.generatedAt, at);
  assert.equal(sampleGraph.nodes.length, count);
});

import { getRootCauseFacts } from './facts.js';

test('getRootCauseFacts: passes through ranked levers with reason description + grounding', () => {
  const rc = getRootCauseFacts(sampleGraph);
  assert.equal(rc.analyzed_at, '2026-05-23T12:00:00.000Z');
  assert.equal(rc.rootCauses.length, 1);
  const lever = rc.rootCauses[0];
  assert.equal(lever.reason, 'ts-loose-client');
  assert.match(lever.reasonDescription, /SupabaseClient/);
  assert.equal(lever.origin.name, 'unresolved-origin');
  assert.equal(lever.origin.shape, 'parameter');
  assert.equal(lever.affectedCount, 1);
  assert.deepEqual(lever.affectedContracts, ['batches']);
  assert.equal(lever.evidence?.length, 1);
  assert.equal(lever.confidence, 'certain'); // deterministic rollup of resolved facts
  assert.deepEqual(lever.scopeBreakdown, { production: 1 });
  assert.equal(lever.productionImpact, true);
});

test('getRootCauseFacts: scope filter keeps only matching affected touches', () => {
  const rc = getRootCauseFacts(sampleGraph, { scope: 'test' });
  assert.equal(rc.rootCauses.length, 0);
});
