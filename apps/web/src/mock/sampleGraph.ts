import type { Graph } from '@throughline/core';

// A small offline demo graph so the web app still renders when the analyzer is
// unreachable. Keep this honest: even mock drift should stay table-level.
export const sampleGraph: Graph = {
  repoPath: '<mock-repo>',
  nodes: [
    {
      id: 'contract:batches',
      kind: 'contract',
      label: 'batches',
      language: 'sql',
      columns: [
        { name: 'id', type: 'uuid', nullable: false },
        { name: 'status', type: 'text', nullable: false },
        { name: 'spice_density', type: 'numeric', nullable: true },
        { name: 'created_by', type: 'uuid', nullable: true },
      ],
      // Per-column read-usage verdicts (offline demo of the four representative
      // tiers). Mirrors what the analyzer emits for a live repo.
      columnUsage: [
        {
          column: 'id',
          verdict: 'used',
          certain: true,
          reach: 'server_only',
          note: 'selected by name in 2 read(s) — certain.',
          evidence: [
            {
              language: 'typescript',
              filePath: 'apps/admin/src/pages/batch.tsx',
              startLine: 42,
              endLine: 42,
              snippet: "const { data } = await supabase.from('batches').select('id, status')",
            },
          ],
        },
        {
          column: 'status',
          verdict: 'likely_rendered',
          certain: false,
          reach: 'ui_shown',
          note: "accessed inside JSX in 1 place(s) via `select('*')` (heuristic: local-scope property access).",
          evidence: [
            {
              language: 'typescript',
              filePath: 'apps/admin/src/pages/batch.tsx',
              startLine: 58,
              endLine: 58,
              snippet: '<span className="badge">{batch.status}</span>',
            },
          ],
        },
        {
          column: 'spice_density',
          verdict: 'likely_dead',
          certain: false,
          reach: 'never_read',
          note: "read via `select('*')` in 1 place(s) but this column is never accessed in local scope (heuristic).",
          evidence: [],
        },
        {
          column: 'created_by',
          verdict: 'unknown',
          certain: false,
          reach: 'unknown',
          note: "read via `select('*')` whose result escaped local scope in 1 read(s) — cannot trace (heuristic).",
          evidence: [
            {
              language: 'typescript',
              filePath: 'apps/admin/src/components/BatchList.tsx',
              startLine: 31,
              endLine: 34,
              snippet: [
                "const { data } = await supabase.from('batches').select('*')",
                'setBatches(data as Batch[])',
              ].join('\n'),
            },
          ],
          // The reference chain up to where the type/trace was lost — followable by hand.
          escapeTrail: [
            {
              language: 'typescript',
              filePath: 'apps/admin/src/components/BatchList.tsx',
              startLine: 31,
              endLine: 31,
              snippet: "const { data } = await supabase.from('batches').select('*')",
            },
            {
              language: 'typescript',
              filePath: 'apps/admin/src/components/BatchList.tsx',
              startLine: 34,
              endLine: 34,
              snippet: 'setBatches(data as Batch[]) // escapes into untyped React state',
            },
          ],
        },
      ],
      source: {
        language: 'sql',
        filePath: 'supabase/migrations/20240115093000_create_batches.sql',
        startLine: 1,
        endLine: 6,
        snippet: [
          'create table batches (',
          '  id uuid primary key default gen_random_uuid(),',
          "  status text not null default 'pending',",
          '  spice_density numeric,',
          '  created_by uuid',
          ');',
        ].join('\n'),
      },
      notes:
        'Source-of-truth contract. Defined by a SQL migration; every column and type downstream derives from here.',
    },
    {
      id: 'touch:ts:batchData',
      kind: 'touch',
      label: 'adminBatch as Batch',
      language: 'typescript',
      trust: 'asserted',
      source: {
        language: 'typescript',
        filePath: 'apps/admin/src/lib/batches.ts',
        startLine: 42,
        endLine: 42,
        snippet: 'const batchData = adminBatch as Batch; // trust me, compiler',
      },
      notes:
        'Reads `batches` but uses an `as` cast. The compiler was told to trust this shape — it is NOT verified against the contract.',
    },
    {
      id: 'touch:rust:batches-writer',
      kind: 'touch',
      label: 'insert into batches',
      language: 'rust',
      trust: 'dark',
      source: {
        language: 'rust',
        filePath: 'services/ingest/src/writer.rs',
        startLine: 88,
        endLine: 93,
        snippet: [
          'sqlx::query("insert into batches (id, status) values ($1, $2)")',
          '    .bind(id)',
          '    .bind(status)',
          '    .execute(&pool)',
          '    .await?;',
        ].join('\n'),
      },
      notes:
        'Detected by shallow grep only — Throughline cannot see the Rust type. Treated as a dark (untyped) write into `batches`.',
    },
  ],
  edges: [
    {
      id: 'edge:ts-reads-batches',
      source: 'touch:ts:batchData',
      target: 'contract:batches',
      direction: 'read',
    },
    {
      id: 'edge:rust-writes-batches',
      source: 'touch:rust:batches-writer',
      target: 'contract:batches',
      direction: 'write',
    },
  ],
  drift: [
    {
      contractId: 'contract:batches',
      message:
        '`batches` is written blind by rust (no shared schema type) and read by typescript. Writers and readers are aligned by hand — a schema change won\'t be caught at any of these boundaries.',
      severity: 'error',
      source: {
        language: 'rust',
        filePath: 'services/ingest/src/writer.rs',
        startLine: 88,
        endLine: 93,
        snippet: 'sqlx::query("insert into batches (id, status) values ($1, $2)")',
      },
    },
  ],
  // RC-b: offline demo of the root-cause rollup. One resolved construction-site
  // lever and one parameter-shape group (with a real signature fix-site), so the
  // Root Causes view renders honestly without the analyzer running.
  rootCauses: [
    {
      reason: 'ts-loose-client',
      origin: {
        name: 'createAdminClient',
        source: {
          language: 'typescript',
          filePath: 'apps/admin/src/lib/supabase.ts',
          startLine: 8,
          endLine: 8,
          snippet: 'export const admin = createAdminClient(url, serviceKey)',
        },
      },
      affectedCount: 1,
      affectedTouchIds: ['touch:ts:batchData'],
      affectedContracts: ['batches'],
    },
    {
      reason: 'ts-cast-concrete',
      origin: { name: 'unresolved-origin', shape: 'parameter' },
      affectedCount: 1,
      affectedTouchIds: ['touch:ts:batchData'],
      affectedContracts: ['batches'],
      evidence: [
        {
          language: 'typescript',
          filePath: 'apps/admin/src/lib/batches.ts',
          startLine: 30,
          endLine: 30,
          snippet: 'export async function loadBatch(admin: SupabaseClient, id: string)',
        },
      ],
    },
    {
      reason: 'ts-loose-client',
      origin: { name: 'unresolved-origin', shape: 'other' },
      affectedCount: 1,
      affectedTouchIds: ['touch:ts:batchData'],
      affectedContracts: ['batches'],
    },
  ],
  generatedAt: '2026-05-21T12:00:00.000Z',
};
