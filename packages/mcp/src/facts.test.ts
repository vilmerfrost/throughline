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

test('getTableFacts: unknown table returns found:false but still carries analyzed_at', () => {
  const t = getTableFacts('does_not_exist', sampleGraph);
  assert.equal(t.found, false);
  assert.equal(t.analyzed_at, '2026-05-23T12:00:00.000Z');
});
