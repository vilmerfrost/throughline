import { strict as assert } from 'node:assert';
import test from 'node:test';
import { Project } from 'ts-morph';
import type { ColumnUsage, GraphNode } from '@throughline/core';
import { computeColumnUsage } from './columnUsage.js';

// Build a contract GraphNode with the given columns.
function contract(table: string, columns: string[]): GraphNode {
  return {
    id: `contract:${table}`,
    kind: 'contract',
    label: table,
    language: 'sql',
    columns: columns.map((name) => ({ name, type: 'text' })),
  };
}

// Run the analyzer over an in-memory .tsx fixture and return the per-column map.
function run(code: string, contracts: GraphNode[]): Map<string, Map<string, ColumnUsage>> {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { jsx: 4 } });
  project.createSourceFile('src/fixture.tsx', code);
  const byTable = computeColumnUsage('/repo', contracts, project);
  const out = new Map<string, Map<string, ColumnUsage>>();
  for (const [table, usages] of byTable) {
    out.set(table, new Map(usages.map((u) => [u.column, u])));
  }
  return out;
}

test('explicit select → used (certain) with real evidence; unnamed columns → likely_dead', () => {
  const code = `
    async function load(sb: any) {
      const { data } = await sb.from('t_explicit').select('id, name');
      return data;
    }
  `;
  const t = run(code, [contract('t_explicit', ['id', 'name', 'age'])]).get('t_explicit')!;

  assert.equal(t.get('id')!.verdict, 'used');
  assert.equal(t.get('id')!.certain, true);
  assert.ok(t.get('id')!.evidence.length >= 1, 'used must carry evidence');
  assert.match(t.get('id')!.evidence[0].snippet, /select\('id, name'\)/);

  assert.equal(t.get('name')!.verdict, 'used');
  assert.equal(t.get('name')!.certain, true);

  assert.equal(t.get('age')!.verdict, 'likely_dead');
  assert.equal(t.get('age')!.certain, false);
  assert.match(t.get('age')!.note, /heuristic/);
});

test("select('*') → code access = likely_used, JSX access = likely_rendered, untouched = likely_dead", () => {
  const code = `
    async function Card(sb: any) {
      const { data: row } = await sb.from('t_star').select('*').single();
      console.log(row.title);
      return <div>{row.body}</div>;
    }
  `;
  const t = run(code, [contract('t_star', ['id', 'title', 'body', 'hidden'])]).get('t_star')!;

  assert.equal(t.get('title')!.verdict, 'likely_used');
  assert.equal(t.get('title')!.certain, false);
  assert.match(t.get('title')!.note, /heuristic/);
  assert.match(t.get('title')!.evidence[0].snippet, /row\.title/);

  assert.equal(t.get('body')!.verdict, 'likely_rendered');
  assert.match(t.get('body')!.evidence[0].snippet, /row\.body/);

  assert.equal(t.get('id')!.verdict, 'likely_dead');
  assert.equal(t.get('hidden')!.verdict, 'likely_dead');
});

test("select('*') result passed to a call → unknown (never likely_dead)", () => {
  const code = `
    async function load(sb: any) {
      const { data } = await sb.from('t_escape').select('*');
      compute(data);
    }
  `;
  const t = run(code, [contract('t_escape', ['id', 'val'])]).get('t_escape')!;

  assert.equal(t.get('id')!.verdict, 'unknown');
  assert.equal(t.get('val')!.verdict, 'unknown');
  assert.equal(t.get('id')!.certain, false);
  assert.ok(t.get('id')!.evidence.length >= 1, 'unknown must carry escape evidence');
  assert.match(t.get('id')!.note, /escaped|trace/);
});

test("select('*') fetched but never bound/used → likely_dead", () => {
  const code = `
    async function load(sb: any) {
      await sb.from('t_dead').select('*');
    }
  `;
  const t = run(code, [contract('t_dead', ['id', 'x'])]).get('t_dead')!;
  assert.equal(t.get('id')!.verdict, 'likely_dead');
  assert.equal(t.get('x')!.verdict, 'likely_dead');
});

test('.then(({ data }) => …) callback: access inside → likely_used, untouched → likely_dead', () => {
  const code = `
    function load(sb: any) {
      sb.from('t_then').select('*').then(({ data }: any) => { record(data.p); });
    }
  `;
  const t = run(code, [contract('t_then', ['id', 'p'])]).get('t_then')!;
  assert.equal(t.get('p')!.verdict, 'likely_used');
  assert.match(t.get('p')!.evidence[0].snippet, /data\.p/);
  assert.equal(t.get('id')!.verdict, 'likely_dead');
});

test('table never read in TS → likely_dead with no evidence and an honest note', () => {
  const code = `
    async function w(sb: any) {
      await sb.from('t_write').insert({ id: 1 });
    }
  `;
  const t = run(code, [contract('t_write', ['id'])]).get('t_write')!;
  assert.equal(t.get('id')!.verdict, 'likely_dead');
  assert.equal(t.get('id')!.evidence.length, 0);
  assert.match(t.get('id')!.note, /no TypeScript read/);
});

test('alias select `a:real_col` resolves to the real column → used', () => {
  const code = `
    async function load(sb: any) {
      const { data } = await sb.from('t_alias').select('a:real_col');
      return data;
    }
  `;
  const t = run(code, [contract('t_alias', ['real_col', 'other'])]).get('t_alias')!;
  assert.equal(t.get('real_col')!.verdict, 'used');
  assert.equal(t.get('real_col')!.certain, true);
  assert.equal(t.get('other')!.verdict, 'likely_dead');
});

test('one read that both accesses and escapes: accessed col → likely_used, the rest → unknown (not dead)', () => {
  const code = `
    async function mix(sb: any) {
      const { data: r } = await sb.from('t_mixed').select('*').single();
      log(r.a);
      save({ ...r });
    }
  `;
  const t = run(code, [contract('t_mixed', ['a', 'b', 'c'])]).get('t_mixed')!;
  assert.equal(t.get('a')!.verdict, 'likely_used');
  assert.equal(t.get('b')!.verdict, 'unknown', 'spread escape must not become likely_dead');
  assert.equal(t.get('c')!.verdict, 'unknown');
});

test("element access rows['col'] is honored", () => {
  const code = `
    async function load(sb: any) {
      const { data: r } = await sb.from('t_elem').select('*').single();
      const v = r['picked'];
      return v;
    }
  `;
  const t = run(code, [contract('t_elem', ['picked', 'skipped'])]).get('t_elem')!;
  assert.equal(t.get('picked')!.verdict, 'likely_used');
  assert.equal(t.get('skipped')!.verdict, 'likely_dead');
});

test('honesty invariants hold across a mixed fixture', () => {
  const code = `
    async function a(sb: any) {
      const { data } = await sb.from('mix').select('id');
      return data;
    }
    async function b(sb: any) {
      const { data } = await sb.from('mix').select('*');
      forward(data);
    }
  `;
  // 'name' is never named in the explicit select and the '*' read escaped →
  // must be unknown, NOT likely_dead.
  const t = run(code, [contract('mix', ['id', 'name'])]).get('mix')!;
  assert.equal(t.get('id')!.verdict, 'used');
  assert.equal(t.get('name')!.verdict, 'unknown');

  for (const u of t.values()) {
    // certain === true ONLY for used
    if (u.certain) assert.equal(u.verdict, 'used');
    // every verdict except a pure likely_dead carries evidence
    if (u.verdict !== 'likely_dead') assert.ok(u.evidence.length >= 1, `${u.column} (${u.verdict}) needs evidence`);
    // every non-used verdict admits it is a heuristic
    if (u.verdict !== 'used') assert.match(u.note, /heuristic/);
  }
});
