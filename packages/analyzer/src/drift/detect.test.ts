import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { GraphEdge, GraphNode, SourceRef } from '@throughline/core';
import { detectDrift } from './detect.js';

function contract(table: string): GraphNode {
  return { id: `contract:${table}`, kind: 'contract', label: table };
}

function source(filePath: string): SourceRef {
  return { language: 'typescript', filePath, startLine: 1, endLine: 1, snippet: 'touch' };
}

function touch(id: string, label: string, sourceScope: GraphNode['sourceScope']): GraphNode {
  return {
    id,
    kind: 'touch',
    label,
    language: 'typescript',
    trust: 'dark',
    trustReason: 'ts-loose-client',
    sourceScope,
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
  assert.match(finding.message, /Every directly traced write/);
});
