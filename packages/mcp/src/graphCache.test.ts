import test from 'node:test';
import assert from 'node:assert/strict';
import type { Graph } from '@throughline/core';
import { GraphCache } from './graphCache.js';
import { sampleGraph } from './__fixtures__/sampleGraph.js';

function clone(g: Graph): Graph {
  return JSON.parse(JSON.stringify(g));
}

test('GraphCache builds on init and exposes the graph', async () => {
  const cache = new GraphCache('/repo', async () => clone(sampleGraph));
  await cache.init();
  assert.equal(cache.graph.repoPath, '/repo');
  assert.equal(cache.graph.nodes.length, sampleGraph.nodes.length);
});

test('reanalyze rebuilds and returns a delta summary vs the previous build', async () => {
  let calls = 0;
  const cache = new GraphCache('/repo', async () => {
    calls += 1;
    const g = clone(sampleGraph);
    g.generatedAt = `2026-05-23T12:0${calls}:00.000Z`;
    // second build drops the python touch + its edge to simulate a fix
    if (calls === 2) {
      g.nodes = g.nodes.filter((n) => !n.id.startsWith('touch:python'));
      g.edges = g.edges.filter((e) => !e.source.startsWith('touch:python'));
    }
    return g;
  });
  await cache.init();
  const summary = await cache.reanalyze();
  assert.equal(calls, 2);
  assert.equal(summary.previous_analyzed_at, '2026-05-23T12:01:00.000Z');
  assert.equal(summary.analyzed_at, '2026-05-23T12:02:00.000Z');
  assert.equal(summary.counts.touches, 1); // was 2
  assert.equal(summary.deltas.touches, -1);
  assert.equal(summary.deltas.edges, -1);
});
