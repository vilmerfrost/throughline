import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleGraph } from './__fixtures__/sampleGraph.js';
import { depthForNode, confidenceForNode, touchFact } from './facts.js';

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
