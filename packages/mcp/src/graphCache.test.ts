import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

test('getAnalysisTarget reports the current initialized target and counts', async () => {
  const cache = new GraphCache('/repo', async () => clone(sampleGraph), 'argv');
  await cache.init();

  const target = cache.getAnalysisTarget();

  assert.equal(target.repoPath, '/repo');
  assert.equal(target.resolved_from, 'argv');
  assert.equal(target.analyzed_at, '2026-05-23T12:00:00.000Z');
  assert.equal(target.ready, true);
  assert.equal(target.counts.nodes, sampleGraph.nodes.length);
  assert.match(target.hints.join('\n'), /get_analysis_target/);
});

test('setAnalysisTarget rebuilds a valid directory and swaps only after success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'throughline-mcp-'));
  const firstRepo = join(root, 'first');
  const secondRepo = join(root, 'second');
  await Promise.all([
    import('node:fs/promises').then((fs) => fs.mkdir(firstRepo)),
    import('node:fs/promises').then((fs) => fs.mkdir(secondRepo)),
  ]);
  let calls = 0;
  const cache = new GraphCache(firstRepo, async (repoPath) => {
    calls += 1;
    const g = clone(sampleGraph);
    g.repoPath = repoPath;
    g.generatedAt = `2026-05-23T12:0${calls}:00.000Z`;
    if (repoPath === secondRepo) {
      g.nodes = g.nodes.filter((n) => n.kind === 'contract');
      g.edges = [];
    }
    return g;
  }, 'env');

  try {
    await cache.init();
    const summary = await cache.setAnalysisTarget({ path: secondRepo, reason: 'agent workspace changed' });

    assert.equal(calls, 2);
    assert.equal(summary.previous.repoPath, firstRepo);
    assert.equal(summary.current.repoPath, secondRepo);
    assert.equal(summary.current.resolved_from, 'runtime');
    assert.equal(summary.current.analyzed_at, '2026-05-23T12:02:00.000Z');
    assert.equal(summary.current.counts.touches, 0);
    assert.equal(cache.graph.repoPath, secondRepo);
    assert.equal(cache.getAnalysisTarget().repoPath, secondRepo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('setAnalysisTarget rejects invalid paths without swapping the cached graph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'throughline-mcp-'));
  const repo = join(root, 'repo');
  await import('node:fs/promises').then((fs) => fs.mkdir(repo));
  let calls = 0;
  const cache = new GraphCache(repo, async (repoPath) => {
    calls += 1;
    const g = clone(sampleGraph);
    g.repoPath = repoPath;
    g.generatedAt = `2026-05-23T12:0${calls}:00.000Z`;
    return g;
  }, 'default');

  try {
    await cache.init();
    await assert.rejects(
      cache.setAnalysisTarget({ path: join(root, 'missing') }),
      /does not exist/,
    );

    assert.equal(calls, 1);
    assert.equal(cache.graph.repoPath, repo);
    assert.equal(cache.getAnalysisTarget().resolved_from, 'default');
    assert.equal(cache.getAnalysisTarget().analyzed_at, '2026-05-23T12:01:00.000Z');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
