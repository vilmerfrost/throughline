import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { Cardinality, Graph, Relationship, SourceRef } from '@throughline/core';
import { buildRelationshipNeighborhood } from './relationships.js';

const src: SourceRef = {
  language: 'sql',
  filePath: 'supabase/migrations/001.sql',
  startLine: 1,
  endLine: 1,
  snippet: 'references x',
};

function rel(
  fromTable: string,
  fromColumn: string,
  toTable: string,
  toColumn: string,
  cardinality: Cardinality = 'many-to-one',
): Relationship {
  return { fromTable, fromColumn, toTable, toColumn, cardinality, source: src };
}

// A graph with the given contract labels and relationships. Contract node ids
// follow the analyzer convention `contract:<label>`.
function graphWith(labels: string[], relationships: Relationship[]): Graph {
  return {
    repoPath: '/repo',
    nodes: labels.map((label) => ({ id: `contract:${label}`, kind: 'contract', label })),
    edges: [],
    drift: [],
    relationships,
    generatedAt: '2026-01-01T00:00:00Z',
  };
}

test('returns null when the contract id is not a known contract', () => {
  const g = graphWith(['a'], []);
  assert.equal(buildRelationshipNeighborhood(g, 'contract:missing'), null);
});

test('outgoing FKs land in references → with the resolved neighbor contract id', () => {
  const g = graphWith(
    ['adapter_runs', 'source_systems'],
    [rel('adapter_runs', 'source_system_id', 'source_systems', 'id')],
  );
  const n = buildRelationshipNeighborhood(g, 'contract:adapter_runs')!;
  assert.equal(n.referencedBy.length, 0);
  assert.equal(n.references.length, 1);
  const e = n.references[0];
  assert.equal(e.neighborLabel, 'source_systems');
  assert.equal(e.neighborContractId, 'contract:source_systems');
  assert.equal(e.fromColumn, 'source_system_id');
  assert.equal(e.toColumn, 'id');
  assert.equal(e.cardinality, 'many-to-one');
  assert.equal(e.external, false);
  assert.equal(e.selfRef, false);
});

test('incoming FKs land in ← referenced by from the perspective of the target', () => {
  const g = graphWith(
    ['batches', 'ml_scores'],
    [rel('ml_scores', 'batch_id', 'batches', 'id')],
  );
  const n = buildRelationshipNeighborhood(g, 'contract:batches')!;
  assert.equal(n.references.length, 0);
  assert.equal(n.referencedBy.length, 1);
  const e = n.referencedBy[0];
  assert.equal(e.neighborLabel, 'ml_scores');
  assert.equal(e.neighborContractId, 'contract:ml_scores');
  assert.equal(e.fromColumn, 'batch_id');
  assert.equal(e.toColumn, 'id');
});

test('a target that is not a scanned contract is marked external with no nav id', () => {
  const g = graphWith(['profiles'], [rel('profiles', 'id', 'users', 'id', 'one-to-one')]);
  const n = buildRelationshipNeighborhood(g, 'contract:profiles')!;
  assert.equal(n.references.length, 1);
  const e = n.references[0];
  assert.equal(e.neighborLabel, 'users');
  assert.equal(e.external, true);
  assert.equal(e.neighborContractId, null);
  assert.equal(e.cardinality, 'one-to-one');
});

test('a contract with no relationships is an island with empty tracks', () => {
  const g = graphWith(['waitlist', 'batches'], [rel('batches', 'x', 'batches', 'id')]);
  const n = buildRelationshipNeighborhood(g, 'contract:waitlist')!;
  assert.equal(n.isIsland, true);
  assert.deepEqual(n.references, []);
  assert.deepEqual(n.referencedBy, []);
});

test('a self-referential FK shows once under references (selfRef), never duplicated in referenced-by', () => {
  const g = graphWith(
    ['inspection_packs'],
    [rel('inspection_packs', 'superseded_by', 'inspection_packs', 'id')],
  );
  const n = buildRelationshipNeighborhood(g, 'contract:inspection_packs')!;
  assert.equal(n.references.length, 1);
  assert.equal(n.referencedBy.length, 0);
  assert.equal(n.references[0].selfRef, true);
  assert.equal(n.references[0].neighborContractId, 'contract:inspection_packs');
  assert.equal(n.isIsland, false);
});

test('tracks are sorted by neighbor label for stable rendering', () => {
  const g = graphWith(
    ['hub', 'zeta', 'alpha', 'mid'],
    [
      rel('hub', 'z_id', 'zeta', 'id'),
      rel('hub', 'a_id', 'alpha', 'id'),
      rel('hub', 'm_id', 'mid', 'id'),
    ],
  );
  const n = buildRelationshipNeighborhood(g, 'contract:hub')!;
  assert.deepEqual(
    n.references.map((e) => e.neighborLabel),
    ['alpha', 'mid', 'zeta'],
  );
});

test('handles a graph with no relationships field at all (older graphs) as an island', () => {
  const g: Graph = {
    repoPath: '/r',
    nodes: [{ id: 'contract:a', kind: 'contract', label: 'a' }],
    edges: [],
    drift: [],
    generatedAt: '2026-01-01T00:00:00Z',
  };
  const n = buildRelationshipNeighborhood(g, 'contract:a')!;
  assert.equal(n.isIsland, true);
});
