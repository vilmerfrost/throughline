import type { Graph } from '@throughline/core';

// A hand-built graph with one contract, a deep TS reader, a shallow Python
// writer, an FK to an external table, one drift finding, and one root cause.
// Small enough to assert exact facts against.
export const sampleGraph: Graph = {
  repoPath: '/repo',
  generatedAt: '2026-05-23T12:00:00.000Z',
  nodes: [
    {
      id: 'contract:batches',
      kind: 'contract',
      label: 'batches',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, hasDefault: true },
        { name: 'recipe', type: 'jsonb', nullable: true },
        { name: 'spice_density', type: 'numeric', nullable: true },
      ],
      columnUsage: [
        {
          column: 'spice_density',
          verdict: 'used',
          certain: true,
          evidence: [
            { language: 'typescript', filePath: 'src/ui/Batch.tsx', startLine: 10, endLine: 10, snippet: 'batch.spice_density' },
          ],
          note: "accessed as `batch.spice_density` (certain)",
          reach: 'ui_shown',
        },
        {
          column: 'recipe',
          verdict: 'unknown',
          certain: false,
          evidence: [],
          note: 'select(*) escaped local scope (heuristic)',
          reach: 'unknown',
          escapeTrail: [
            { language: 'typescript', filePath: 'src/lib/api.ts', startLine: 5, endLine: 5, snippet: 'return data' },
          ],
        },
      ],
    },
    {
      id: 'touch:ts:src/ui/Batch.tsx:10:batches',
      kind: 'touch',
      label: 'read batches',
      language: 'typescript',
      trust: 'verified',
      trustReason: 'ts-verified',
      sourceScope: 'production',
      source: { language: 'typescript', filePath: 'src/ui/Batch.tsx', startLine: 10, endLine: 12, snippet: "supabase.from('batches').select('spice_density')" },
    },
    {
      id: 'touch:python:scripts/seed.py:3:batches',
      kind: 'touch',
      label: 'write batches',
      language: 'python',
      trust: 'dark',
      trustReason: 'shallow-grep-python',
      sourceScope: 'script',
      source: { language: 'python', filePath: 'scripts/seed.py', startLine: 3, endLine: 3, snippet: "client.table('batches').insert(row)" },
    },
  ],
  edges: [
    { id: 'edge:touch:ts:src/ui/Batch.tsx:10:batches', source: 'touch:ts:src/ui/Batch.tsx:10:batches', target: 'contract:batches', direction: 'read' },
    { id: 'edge:touch:python:scripts/seed.py:3:batches', source: 'touch:python:scripts/seed.py:3:batches', target: 'contract:batches', direction: 'write' },
  ],
  drift: [
    {
      contractId: 'contract:batches',
      message: 'Python write to batches is dark (shallow grep).',
      severity: 'warn',
      scopeBreakdown: { script: 1 },
      productionImpact: false,
      testOnly: false,
      source: { language: 'python', filePath: 'scripts/seed.py', startLine: 3, endLine: 3, snippet: "client.table('batches').insert(row)" },
    },
  ],
  relationships: [
    {
      fromTable: 'batches',
      fromColumn: 'org_id',
      toTable: 'orgs',
      toColumn: 'id',
      cardinality: 'many-to-one',
      source: { language: 'sql', filePath: 'migrations/001.sql', startLine: 7, endLine: 7, snippet: 'org_id uuid REFERENCES orgs(id)' },
    },
  ],
  rootCauses: [
    {
      reason: 'ts-loose-client',
      origin: { name: 'unresolved-origin', shape: 'parameter' },
      affectedCount: 1,
      affectedTouchIds: ['touch:ts:src/ui/Batch.tsx:10:batches'],
      affectedContracts: ['batches'],
      evidence: [
        { language: 'typescript', filePath: 'src/lib/api.ts', startLine: 1, endLine: 1, snippet: 'function q(client) {' },
      ],
    },
  ],
};
