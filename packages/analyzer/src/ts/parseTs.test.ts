import { strict as assert } from 'node:assert';
import test from 'node:test';
import { Project } from 'ts-morph';
import type { GraphNode, SourceScope, Trust } from '@throughline/core';
import { parseTs } from './parseTs.js';

// ---------------------------------------------------------------------------
// Client-type detection tests. A `.from()` touch is `verified`/`narrowed` only
// when the receiver is GENUINELY typed as `SupabaseClient<Database>`. The hard
// case (and the bug these tests pin) is a type ALIAS: `type Admin =
// SupabaseClient<Database>` displays as `Admin` in getText(), so a naive
// substring check sees neither "SupabaseClient" nor "Database" and falsely
// reports `dark`. Resolution must see through the alias WITHOUT loosening:
// bare `SupabaseClient` and `& SupabaseClient` intersections stay dark.
// ---------------------------------------------------------------------------

// Stand-in for @supabase/supabase-js: a generic client whose Database param
// defaults to `any` (mirroring the real type), so a bare `SupabaseClient` is
// genuinely untyped.
const CLIENT_MODULE = `
import type { Database } from './db';
export declare class SupabaseClient<DB = any> { from(t: string): any; }
export type Admin = SupabaseClient<Database>;
export type Admin2 = Admin;
export type Bare = SupabaseClient;
export type Lie = SupabaseClient & SupabaseClient<Database>;
export type AnyArg = SupabaseClient<any>;
`;

function contract(table: string): GraphNode {
  return { id: `contract:${table}`, kind: 'contract', label: table, language: 'sql' };
}

// Build a project around a single `.from('batches')` whose receiver is declared
// with the given type, run parseTs, and return the resulting touch's trust.
async function trustOf(receiverType: string): Promise<Trust | undefined> {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile('db.ts', `export type Database = { public: { Tables: {} } };`);
  project.createSourceFile('client.ts', CLIENT_MODULE);
  project.createSourceFile(
    'use.ts',
    `import { SupabaseClient, Admin, Admin2, Bare, Lie, AnyArg } from './client';
     import type { Database } from './db';
     declare const client: ${receiverType};
     async function run() { await client.from('batches').select('*'); }`,
  );
  const { nodes } = await parseTs('/', [contract('batches')], project);
  return nodes.find((n) => n.kind === 'touch')?.trust;
}

async function touchesFor(files: Record<string, string>, tables = ['batches']): Promise<GraphNode[]> {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { jsx: 4 } });
  project.createSourceFile(
    '/repo/app/types.ts',
    `
      export type Database = { public: { Tables: {} } };
      export declare class SupabaseClient<DB = any> {
        from(table: string): {
          select(cols?: string): any;
          insert(payload: any): any;
          update(payload: any): any;
          eq(col: string, value: any): any;
        };
      }
    `,
  );
  for (const [filePath, code] of Object.entries(files)) {
    project.createSourceFile(`/repo/${filePath}`, code);
  }
  const { nodes } = await parseTs('/repo', tables.map(contract), project);
  return nodes;
}

test('inline SupabaseClient<Database> → verified (baseline, no regression)', async () => {
  assert.equal(await trustOf('SupabaseClient<Database>'), 'verified');
});

test('alias to SupabaseClient<Database> resolves → verified', async () => {
  assert.equal(await trustOf('Admin'), 'verified');
});

test('alias chain (alias → alias → SupabaseClient<Database>) resolves → verified', async () => {
  assert.equal(await trustOf('Admin2'), 'verified');
});

test('bare SupabaseClient (DB defaults to any) stays dark', async () => {
  assert.equal(await trustOf('SupabaseClient'), 'dark');
});

test('alias to bare SupabaseClient stays dark', async () => {
  assert.equal(await trustOf('Bare'), 'dark');
});

test('explicit SupabaseClient<any> stays dark', async () => {
  assert.equal(await trustOf('AnyArg'), 'dark');
});

test('intersection `SupabaseClient & SupabaseClient<Database>` stays dark (bare arm reopens access)', async () => {
  assert.equal(await trustOf('Lie'), 'dark');
});

test('touches carry sourceScope classified from the source path', async () => {
  const nodes = await touchesFor({
    'app/lib/read.ts': `
      import type { SupabaseClient, Database } from '../types';
      declare const admin: SupabaseClient<Database>;
      export async function read() { return admin.from('batches').select('*'); }
    `,
    'tests/rls/write.test.ts': `
      declare const loose: any;
      export async function write() { return loose.from('batches').insert({ id: 1 }); }
    `,
  });

  const scopes = new Map(nodes.map((n) => [n.source?.filePath, n.sourceScope]));
  assert.equal(scopes.get('app/lib/read.ts'), 'production' satisfies SourceScope);
  assert.equal(scopes.get('tests/rls/write.test.ts'), 'test' satisfies SourceScope);
});

test('simple Supabase table helper calls resolve as table touches at the call site', async () => {
  const nodes = await touchesFor({
    'app/lib/helpers.ts': `
      import type { SupabaseClient, Database } from '../types';
      export function adapterRunsTable(admin: SupabaseClient<Database>) {
        return admin.from('batches');
      }
    `,
    'app/lib/use-helper.ts': `
      import type { SupabaseClient, Database } from '../types';
      import { adapterRunsTable } from './helpers';
      declare const admin: SupabaseClient<Database>;
      export async function writeRun() {
        return adapterRunsTable(admin).insert({ id: 1 });
      }
    `,
  });

  const helperTouch = nodes.find((n) => n.source?.filePath === 'app/lib/helpers.ts');
  const callSiteTouch = nodes.find((n) => n.source?.filePath === 'app/lib/use-helper.ts');
  assert.equal(helperTouch?.label, 'read batches');
  assert.equal(callSiteTouch?.label, 'write batches');
  assert.equal(callSiteTouch?.trust, 'verified');
  assert.match(callSiteTouch?.source?.snippet ?? '', /adapterRunsTable\(admin\)\.insert/);
});
