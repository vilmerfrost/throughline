import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { GraphNode } from '@throughline/core';
import { analyzePythonSource, attachPythonSchemaMatch, type PythonWriteSite } from './schemaMatch.js';

function contract(table: string, columns: Array<[string, boolean, boolean?]>): GraphNode {
  return {
    id: `contract:${table}`,
    kind: 'contract',
    label: table,
    language: 'sql',
    columns: columns.map(([name, nullable, hasDefault]) => ({ name, type: 'text', nullable, hasDefault })),
  };
}

// Mirror the Rust analyzer's `batches` fixture so we test the same NOT-NULL /
// DEFAULT rules from a different language. id/status/started_at/model_version
// are NOT NULL *with a default*; batch_number/product are NOT NULL *without*.
function batches(): GraphNode {
  return contract('batches', [
    ['id', false, true],
    ['batch_number', false],
    ['product', false],
    ['status', false, true],
    ['started_at', false, true],
    ['ended_at', true],
    ['model_version', false, true],
    ['notes', true],
  ]);
}

function only(sites: PythonWriteSite[]): PythonWriteSite {
  assert.equal(sites.length, 1, `expected exactly one write site, got ${sites.length}`);
  return sites[0];
}

test('insert with inline dict literal naming required columns → aligned', async () => {
  const code = `
def create(client):
    client.table("batches").insert({
        "batch_number": "B-1",
        "product": "P-1",
    }).execute()
`;
  const site = only(await analyzePythonSource(code, [batches()]));
  assert.equal(site.table, 'batches');
  assert.equal(site.verb, 'insert');
  assert.equal(site.schemaMatch, 'aligned');
  assert.equal(site.drift.length, 0);
  assert.equal(site.resolved?.kind, 'dict');
  assert.deepEqual(site.resolved?.keys.slice().sort(), ['batch_number', 'product']);
});

test('insert with payload bound to a local dict variable resolves the keys', async () => {
  const code = `
def create(client):
    payload = {"batch_number": "B-1", "product": "P-1"}
    client.table("batches").insert(payload).execute()
`;
  const site = only(await analyzePythonSource(code, [batches()]));
  assert.equal(site.schemaMatch, 'aligned');
  assert.equal(site.resolved?.keys.length, 2);
});

test('insert with kwargs (insert(id=..., status=...)) resolves to those keys', async () => {
  const code = `
def patch(client):
    client.table("batches").update(status="completed", ended_at=now).eq("id", id).execute()
`;
  const site = only(await analyzePythonSource(code, [batches()]));
  assert.equal(site.verb, 'update');
  assert.equal(site.schemaMatch, 'aligned'); // update never requires NOT-NULL cols
  assert.equal(site.resolved?.kind, 'kwargs');
  assert.deepEqual(site.resolved?.keys.slice().sort(), ['ended_at', 'status']);
});

test('insert with unknown key → mismatch + a python-unknown-key drift finding', async () => {
  const code = `
def create(client):
    client.table("batches").insert({"batch_number": "B", "product": "P", "bogus": 1}).execute()
`;
  const site = only(await analyzePythonSource(code, [batches()]));
  assert.equal(site.schemaMatch, 'mismatch');
  const f = site.drift.find((d) => d.message.includes('`bogus`'));
  assert.ok(f, 'expected a drift finding for the unknown key');
  assert.equal(f!.kind, 'python-unknown-key');
  assert.equal(f!.fixability, 'actionable');
  assert.match(f!.recommendedAction ?? '', /Rename or remove the unknown key/);
});

test('insert omitting a NOT-NULL no-default column → mismatch + python-missing-required-column', async () => {
  const code = `
def create(client):
    client.table("batches").insert({"batch_number": "B"}).execute()
`;
  const site = only(await analyzePythonSource(code, [batches()]));
  assert.equal(site.schemaMatch, 'mismatch');
  const missing = site.drift.find((d) => d.kind === 'python-missing-required-column');
  assert.ok(missing, 'expected a missing-required finding');
  assert.match(missing!.message, /`product`/);
});

test('payload built dynamically (dict comprehension) stays dark — never a column-level claim', async () => {
  const code = `
def create(client, rows):
    payload = {k: v for k, v in rows.items()}
    client.table("batches").insert(payload).execute()
`;
  const site = only(await analyzePythonSource(code, [batches()]));
  assert.equal(site.schemaMatch, 'dark');
  assert.equal(site.resolved, null);
  assert.equal(site.drift.length, 0);
});

test('dict with **kwargs spread stays dark (spread keys are invisible to us)', async () => {
  const code = `
def create(client, extra):
    payload = {"batch_number": "B", **extra}
    client.table("batches").insert(payload).execute()
`;
  const site = only(await analyzePythonSource(code, [batches()]));
  assert.equal(site.schemaMatch, 'dark');
  assert.equal(site.resolved, null);
});

test('list of literal dicts: aligned when every row has only valid keys', async () => {
  const code = `
def bulk(client):
    client.table("batches").insert([
        {"batch_number": "B-1", "product": "P-1"},
        {"batch_number": "B-2", "product": "P-2"},
    ]).execute()
`;
  const site = only(await analyzePythonSource(code, [batches()]));
  assert.equal(site.schemaMatch, 'aligned');
  assert.ok(site.resolved);
});

test('list with a non-literal row stays dark', async () => {
  const code = `
def bulk(client, more):
    client.table("batches").insert([
        {"batch_number": "B-1"},
        more,
    ]).execute()
`;
  const site = only(await analyzePythonSource(code, [batches()]));
  assert.equal(site.schemaMatch, 'dark');
});

test('write against unknown table is ignored (no fabricated contract)', async () => {
  const sites = await analyzePythonSource(
    `def x(client): client.table("ghost").insert({"x": 1}).execute()`,
    [batches()],
  );
  assert.equal(sites.length, 0);
});

function pyTouch(table: string, direction: 'read' | 'write', filePath: string, line: number): GraphNode {
  return {
    id: `touch:python:${filePath}:${line}:${table}`,
    kind: 'touch',
    language: 'python',
    label: `${direction} ${table}`,
    trust: 'dark',
    source: { language: 'python', filePath, startLine: line, endLine: line, snippet: '' },
  };
}

function siteFixture(
  table: string,
  verb: PythonWriteSite['verb'],
  filePath: string,
  callLine: number,
  schemaMatch: PythonWriteSite['schemaMatch'],
): PythonWriteSite {
  return {
    table, verb, callLine, schemaMatch,
    resolved: schemaMatch === 'dark' ? null : { kind: 'dict', keys: [] },
    source: { language: 'python', filePath, startLine: callLine, endLine: callLine, snippet: '' },
    drift: [],
  };
}

test('attachPythonSchemaMatch stamps verdicts onto the right Python WRITE touches', () => {
  const f = 'app/services/batches.py';
  const w1 = pyTouch('batches', 'write', f, 12);
  const w2 = pyTouch('batches', 'write', f, 80);
  const r = pyTouch('batches', 'read', f, 30);
  const rust: GraphNode = { ...pyTouch('batches', 'write', 'src/lib.rs', 10), language: 'rust' };
  attachPythonSchemaMatch([w1, w2, r, rust], [
    siteFixture('batches', 'insert', f, 12, 'aligned'),
    siteFixture('batches', 'update', f, 80, 'mismatch'),
  ]);
  assert.equal(w1.schemaMatch, 'aligned');
  assert.equal(w2.schemaMatch, 'mismatch');
  assert.equal(r.schemaMatch, undefined, 'reads get no schemaMatch');
  assert.equal(rust.schemaMatch, undefined, 'non-Python touches are untouched');
});
