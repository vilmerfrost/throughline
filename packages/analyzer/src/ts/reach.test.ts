import { strict as assert } from 'node:assert';
import test from 'node:test';
import { Project } from 'ts-morph';
import type { ColumnUsage, GraphNode, SqlViewRead } from '@throughline/core';
import { computeColumnUsage } from './columnUsage.js';

// ---------------------------------------------------------------------------
// Reach axis tests. Reach is traced from REAL types, so fixtures must give the
// read result a concrete type. The honest trick: annotate the destructure
// (`const { data }: { data: Row | null } = …`) so `data` is typed even though
// the fake `sb` is `any`. Leaving the annotation off keeps `data` as `any`,
// which models an untyped client — those reads must come back `unknown`.
// ---------------------------------------------------------------------------

function contract(table: string, columns: string[]): GraphNode {
  return {
    id: `contract:${table}`,
    kind: 'contract',
    label: table,
    language: 'sql',
    columns: columns.map((name) => ({ name, type: 'text' })),
  };
}

function runFiles(files: Record<string, string>, contracts: GraphNode[], sqlViewReads: SqlViewRead[] = []) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { jsx: 4 } });
  for (const [name, code] of Object.entries(files)) project.createSourceFile(name, code);
  const byTable = computeColumnUsage('/repo', contracts, project, sqlViewReads);
  const out = new Map<string, Map<string, ColumnUsage>>();
  for (const [table, usages] of byTable) out.set(table, new Map(usages.map((u) => [u.column, u])));
  return out;
}

function run(code: string, contracts: GraphNode[], sqlViewReads: SqlViewRead[] = []) {
  return runFiles({ 'src/fixture.tsx': code }, contracts, sqlViewReads);
}

test('typed single-row column accessed inside JSX → ui_shown', () => {
  const code = `
    interface Row { id: string; status: string; secret: string; }
    async function Page(sb: any) {
      const { data }: { data: Row | null } = await sb.from('batches').select('*').single();
      return <div>{data!.status}</div>;
    }
  `;
  const t = run(code, [contract('batches', ['id', 'status', 'secret'])]).get('batches')!;
  assert.equal(t.get('status')!.reach, 'ui_shown');
});

test('typed column accessed only outside JSX → server_only', () => {
  const code = `
    interface Row { id: string; org_id: string; }
    async function check(sb: any): Promise<boolean> {
      const { data }: { data: Row | null } = await sb.from('batches').select('*').single();
      return data?.org_id === 'x';
    }
  `;
  const t = run(code, [contract('batches', ['id', 'org_id'])]).get('batches')!;
  assert.equal(t.get('org_id')!.reach, 'server_only');
});

test('column named in an explicit select but never accessed → server_only (read server-side)', () => {
  const code = `
    interface Row { id: string; org_id: string; }
    async function check(sb: any): Promise<string | undefined> {
      const { data }: { data: Row | null } = await sb.from('batches').select('id, org_id').single();
      return data?.org_id;
    }
  `;
  const t = run(code, [contract('batches', ['id', 'org_id'])]).get('batches')!;
  // id is selected (a server-side read) but never read out → server_only, NOT never_read.
  assert.equal(t.get('id')!.reach, 'server_only');
});

test('JSX access wins over code access → ui_shown', () => {
  const code = `
    interface Row { title: string; }
    async function Page(sb: any) {
      const { data }: { data: Row | null } = await sb.from('t').select('*').single();
      console.log(data!.title);
      return <h1>{data!.title}</h1>;
    }
  `;
  const t = run(code, [contract('t', ['title'])]).get('t')!;
  assert.equal(t.get('title')!.reach, 'ui_shown');
});

test('typed array .map(r => r.col) inside JSX → ui_shown', () => {
  const code = `
    interface Row { id: string; name: string; }
    async function List(sb: any) {
      const { data }: { data: Row[] } = await sb.from('t').select('*');
      return <ul>{data.map((r) => <li key={r.id}>{r.name}</li>)}</ul>;
    }
  `;
  const t = run(code, [contract('t', ['id', 'name'])]).get('t')!;
  assert.equal(t.get('name')!.reach, 'ui_shown');
  assert.equal(t.get('id')!.reach, 'ui_shown'); // key={r.id} is inside JSX
});

test('typed array element access r[0].col consumed in server code → server_only', () => {
  const code = `
    interface Row { a: string; b: string; }
    async function f(sb: any) {
      const { data }: { data: Row[] } = await sb.from('t').select('*');
      if (data[0].a === 'x') throw new Error('nope');
    }
  `;
  const t = run(code, [contract('t', ['a', 'b'])]).get('t')!;
  assert.equal(t.get('a')!.reach, 'server_only');
  assert.equal(t.get('b')!.reach, 'never_read');
});

test('untyped (any) property access → unknown with an escape trail, never classified', () => {
  const code = `
    async function Page(sb: any) {
      const { data } = await sb.from('t').select('*').single();
      return <div>{data.title}</div>;
    }
  `;
  const t = run(code, [contract('t', ['title', 'other'])]).get('t')!;
  assert.equal(t.get('title')!.reach, 'unknown');
  assert.ok((t.get('title')!.escapeTrail?.length ?? 0) >= 1, 'unknown must carry an escape trail');
});

test('typed result escaping into an untyped call → unknown (cannot rule out UI)', () => {
  const code = `
    interface Row { a: string; b: string; }
    declare function sendToClaude(x: any): void;
    async function load(sb: any) {
      const { data }: { data: Row[] } = await sb.from('t').select('*');
      sendToClaude(data);
    }
  `;
  const t = run(code, [contract('t', ['a', 'b'])]).get('t')!;
  assert.equal(t.get('a')!.reach, 'unknown');
  assert.equal(t.get('b')!.reach, 'unknown');
  assert.ok((t.get('a')!.escapeTrail?.length ?? 0) >= 1);
});

test('conservative: a typed star read that fully resolves leaves untouched columns never_read', () => {
  const code = `
    interface Row { used: string; unused: string; }
    async function f(sb: any): Promise<string> {
      const { data }: { data: Row | null } = await sb.from('t').select('*').single();
      return data?.used ?? '';
    }
  `;
  const t = run(code, [contract('t', ['used', 'unused'])]).get('t')!;
  assert.equal(t.get('used')!.reach, 'server_only');
  assert.equal(t.get('unused')!.reach, 'never_read');
});

test('honesty: no never_read when an escaping/untyped star read of the table exists', () => {
  const code = `
    declare function stash(x: any): void;
    async function f(sb: any) {
      const { data } = await sb.from('t').select('*'); // untyped star read — could carry any column
      stash(data);
    }
  `;
  const t = run(code, [contract('t', ['a', 'b', 'c'])]).get('t')!;
  for (const col of ['a', 'b', 'c']) {
    assert.equal(t.get(col)!.reach, 'unknown', `${col} must be unknown, never never_read`);
    assert.ok((t.get(col)!.escapeTrail?.length ?? 0) >= 1);
  }
});

test('table never read in TS at all → never_read', () => {
  const code = `
    async function w(sb: any) {
      await sb.from('t').insert({ id: 1 });
    }
  `;
  const t = run(code, [contract('t', ['id', 'x'])]).get('t')!;
  assert.equal(t.get('id')!.reach, 'never_read');
  assert.equal(t.get('x')!.reach, 'never_read');
});

test('SQL view column read turns an otherwise unread column into server_only', () => {
  const code = `
    async function w(sb: any) {
      await sb.from('t').insert({ id: 1 });
    }
  `;
  const viewRead: SqlViewRead = {
    viewName: 'v_t',
    table: 't',
    columns: ['id'],
    confidence: 'certain',
    source: {
      language: 'sql',
      filePath: 'supabase/migrations/001.sql',
      startLine: 10,
      endLine: 12,
      snippet: 'create view v_t as select id from t;',
    },
  };
  const t = run(code, [contract('t', ['id', 'x'])], [viewRead]).get('t')!;
  assert.equal(t.get('id')!.reach, 'server_only');
  assert.equal(t.get('x')!.reach, 'never_read');
});

test('opaque SQL view table read prevents never_read for every column it may read', () => {
  const code = `
    async function w(sb: any) {
      await sb.from('t').insert({ id: 1 });
    }
  `;
  const viewRead: SqlViewRead = {
    viewName: 'v_t_complex',
    table: 't',
    confidence: 'opaque',
    note: 'View reads this table but columns could not be attributed.',
    source: {
      language: 'sql',
      filePath: 'supabase/migrations/001.sql',
      startLine: 10,
      endLine: 18,
      snippet: 'create view v_t_complex as with x as (...) select * from x;',
    },
  };
  const t = run(code, [contract('t', ['id', 'x'])], [viewRead]).get('t')!;
  assert.equal(t.get('id')!.reach, 'unknown');
  assert.equal(t.get('x')!.reach, 'unknown');
  assert.ok((t.get('id')!.escapeTrail?.length ?? 0) >= 1);
});

test('cross-file: typed rows returned from a lib and rendered in a page → ui_shown', () => {
  const files = {
    'src/types.ts': `export interface Row { id: string; title: string; }`,
    'src/data.ts': `
      import type { Row } from './types';
      export async function getRows(sb: any): Promise<Row[]> {
        const { data }: { data: Row[] } = await sb.from('t').select('*');
        return data;
      }
    `,
    'src/Page.tsx': `
      import { getRows } from './data';
      export async function Page(sb: any) {
        const rows = await getRows(sb);
        return <ul>{rows.map((r) => <li>{r.title}</li>)}</ul>;
      }
    `,
  };
  const t = runFiles(files, [contract('t', ['id', 'title'])]).get('t')!;
  assert.equal(t.get('title')!.reach, 'ui_shown');
});

test('hop cap: a pass-through chain longer than the cap stops and records the trail → unknown', () => {
  const code = `
    interface Row { a: string; }
    async function f(sb: any) {
      const { data }: { data: Row[] } = await sb.from('t').select('*');
      const h1 = data;
      const h2 = h1;
      const h3 = h2;
      const h4 = h3;
      const h5 = h4;
      const h6 = h5;
      const h7 = h6;
      const h8 = h7;
      return h8[0].a;
    }
  `;
  const t = run(code, [contract('t', ['a'])]).get('t')!;
  assert.equal(t.get('a')!.reach, 'unknown');
  assert.ok((t.get('a')!.escapeTrail?.length ?? 0) >= 1);
});
