import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { GraphNode } from '@throughline/core';
import { analyzeRustSource, attachSchemaMatch, type RustWriteSite } from './schemaMatch.js';

// Build a contract GraphNode. Columns are [name, nullable, hasDefault?] tuples so
// tests can pin which columns are NOT-NULL (required on insert) and which carry a
// DEFAULT (optional on insert even when NOT NULL).
function contract(table: string, columns: Array<[string, boolean, boolean?]>): GraphNode {
  return {
    id: `contract:${table}`,
    kind: 'contract',
    label: table,
    language: 'sql',
    columns: columns.map(([name, nullable, hasDefault]) => ({ name, type: 'text', nullable, hasDefault })),
  };
}

// The real Batch-Guard `batches` contract: NOT-NULL set AND DEFAULT set mirror the
// migrations. id/status/started_at/model_version are NOT NULL *with a default*;
// batch_number and product are NOT NULL *without* a default.
function batches(): GraphNode {
  return contract('batches', [
    ['id', false, true],
    ['org_id', true],
    ['process_id', true],
    ['batch_number', false],
    ['product', false],
    ['status', false, true],
    ['started_at', false, true],
    ['ended_at', true],
    ['created_by', true],
    ['model_version', false, true],
    ['notes', true],
    ['archived_at', true],
    ['archived_by', true],
    ['recipe_id', true],
    ['recipe_version', true],
    ['order_number', true],
    ['product_source', true],
    ['product_opc_node_id', true],
    ['product_opc_quality', true],
    ['product_source_timestamp', true],
  ]);
}

function only(sites: RustWriteSite[]): RustWriteSite {
  assert.equal(sites.length, 1, `expected exactly one write site, got ${sites.length}`);
  return sites[0];
}

test('INSERT body built by a local builder returning a #[derive(Serialize)] struct → aligned', async () => {
  const code = `
#[derive(Serialize)]
struct BatchInsertPayload<'a> {
    id: &'a str,
    batch_number: &'a str,
    product: &'a str,
    status: &'a str,
    started_at: &'a str,
    model_version: &'a str,
    notes: Option<&'a str>,
}
impl Client {
    async fn create(&self) {
        let body = Self::build_batch_insert_payload();
        self.client
            .post(format!("{}/rest/v1/batches", self.url))
            .json(&body)
            .send()
            .await;
    }
    fn build_batch_insert_payload<'a>() -> BatchInsertPayload<'a> { todo!() }
}
`;
  const site = only(await analyzeRustSource(code, [batches()]));
  assert.equal(site.table, 'batches');
  assert.equal(site.verb, 'insert');
  assert.equal(site.schemaMatch, 'aligned');
  assert.equal(site.drift.length, 0);
  assert.ok(site.resolved, 'aligned must carry the resolved body');
  assert.equal(site.resolved!.kind, 'struct');
  assert.equal(site.resolved!.structName, 'BatchInsertPayload');
  assert.deepEqual(site.resolved!.keys.slice().sort(), [
    'batch_number', 'id', 'model_version', 'notes', 'product', 'started_at', 'status',
  ]);
});

test('inline `&StructLiteral { .. }` resolves through the struct def → aligned', async () => {
  const code = `
#[derive(Serialize)]
struct Patch<'a> { status: &'a str, ended_at: &'a str }
impl Client {
    async fn done(&self) {
        self.client
            .patch(format!("{}/rest/v1/batches?id=eq.{}", self.url, id))
            .json(&Patch { status: "completed", ended_at: ts })
            .send().await;
    }
}
`;
  const site = only(await analyzeRustSource(code, [batches()]));
  assert.equal(site.verb, 'update');
  assert.equal(site.schemaMatch, 'aligned');
  assert.equal(site.resolved!.structName, 'Patch');
});

test('PATCH with inline serde_json::json!({..literal keys..}) → aligned (update needs no NOT-NULL cols)', async () => {
  const code = `
impl Client {
    async fn complete(&self, id: &str) {
        let body = serde_json::json!({ "status": "completed", "ended_at": now });
        self.client
            .patch(format!("{}/rest/v1/batches?id=eq.{}", self.url, id))
            .json(&body)
            .send().await;
    }
}
`;
  const site = only(await analyzeRustSource(code, [batches()]));
  assert.equal(site.verb, 'update');
  assert.equal(site.schemaMatch, 'aligned');
  assert.equal(site.resolved!.kind, 'json');
  assert.deepEqual(site.resolved!.keys.slice().sort(), ['ended_at', 'status']);
  assert.equal(site.drift.length, 0);
});

test('builder returning serde_json::Value (dynamic) → dark, never a mismatch, no drift', async () => {
  const code = `
impl Client {
    async fn recipe(&self, id: &str) {
        let body = Self::build_recipe_update_body();
        self.client
            .patch(format!("{}/rest/v1/batches?id=eq.{}", self.url, id))
            .json(&body)
            .send().await;
    }
    fn build_recipe_update_body() -> serde_json::Value { todo!() }
}
`;
  const site = only(await analyzeRustSource(code, [batches()]));
  assert.equal(site.schemaMatch, 'dark');
  assert.equal(site.resolved, null);
  assert.equal(site.drift.length, 0, 'unresolved writes never produce drift findings');
});

test('locally-built HashMap → dark (no guessing)', async () => {
  const code = `
impl Client {
    async fn patch_it(&self, id: &str) {
        let mut body = std::collections::HashMap::new();
        body.insert("status", "x");
        self.client
            .patch(format!("{}/rest/v1/batches?id=eq.{}", self.url, id))
            .json(&body)
            .send().await;
    }
}
`;
  const site = only(await analyzeRustSource(code, [batches()]));
  assert.equal(site.schemaMatch, 'dark');
  assert.equal(site.resolved, null);
  assert.equal(site.drift.length, 0);
});

test('INSERT struct omitting NOT-NULL columns → mismatch + a drift finding naming each missing column', async () => {
  const code = `
#[derive(Serialize)]
struct Bad<'a> { id: &'a str, status: &'a str }
impl Client {
    async fn create(&self) {
        self.client
            .post(format!("{}/rest/v1/batches", self.url))
            .json(&Bad { id, status })
            .send().await;
    }
}
`;
  const site = only(await analyzeRustSource(code, [batches()]));
  assert.equal(site.verb, 'insert');
  assert.equal(site.schemaMatch, 'mismatch');
  assert.ok(site.resolved, 'mismatch must be grounded in a resolved struct');
  // batch_number and product are NOT NULL *without* a default → must be flagged.
  for (const col of ['batch_number', 'product']) {
    const f = site.drift.find((d) => d.message.includes(`\`${col}\``));
    assert.ok(f, `expected a drift finding for missing NOT-NULL column ${col}`);
    assert.match(f!.message, /omits NOT-NULL column/);
    assert.equal(f!.contractId, 'contract:batches');
    assert.equal(f!.source.language, 'rust');
    assert.match(f!.message, /Bad/, 'finding should name the real struct');
  }
  // started_at and model_version are NOT NULL *with* a default → must NOT be flagged.
  for (const col of ['started_at', 'model_version']) {
    assert.ok(
      !site.drift.some((d) => d.message.includes(`\`${col}\``)),
      `NOT-NULL-with-default column ${col} must not be flagged as omitted`,
    );
  }
});

test('INSERT omitting a NOT-NULL column that HAS a default is not a mismatch (no false positive)', async () => {
  // Provides only the two NOT-NULL-no-default columns; omits the defaulted PK
  // and the defaulted NOT-NULL columns. Postgres fills those → still aligned.
  const code = `
#[derive(Serialize)]
struct Ins<'a> { batch_number: &'a str, product: &'a str }
impl Client {
    async fn create(&self) {
        self.client
            .post(format!("{}/rest/v1/batches", self.url))
            .json(&Ins { batch_number, product })
            .send().await;
    }
}
`;
  const site = only(await analyzeRustSource(code, [batches()]));
  assert.equal(site.verb, 'insert');
  assert.equal(site.schemaMatch, 'aligned');
  assert.equal(site.drift.length, 0);
});

test('write of a key that is not a column → mismatch + a drift finding naming the unknown key', async () => {
  const code = `
impl Client {
    async fn patch_it(&self, id: &str) {
        let body = serde_json::json!({ "status": "x", "bogus_col": 1 });
        self.client
            .patch(format!("{}/rest/v1/batches?id=eq.{}", self.url, id))
            .json(&body)
            .send().await;
    }
}
`;
  const site = only(await analyzeRustSource(code, [batches()]));
  assert.equal(site.schemaMatch, 'mismatch');
  const f = site.drift.find((d) => d.message.includes('`bogus_col`'));
  assert.ok(f, 'expected a drift finding for the unknown key');
  assert.match(f!.message, /writes unknown key/);
  assert.equal(f!.source.language, 'rust');
});

test('Option<T> fields are nullable; #[serde(rename="…")] changes the serialized key', async () => {
  const code = `
#[derive(Serialize)]
struct R<'a> {
    #[serde(rename = "product")]
    prod: &'a str,
    notes: Option<&'a str>,
}
impl Client {
    async fn patch_it(&self, id: &str) {
        self.client
            .patch(format!("{}/rest/v1/batches?id=eq.{}", self.url, id))
            .json(&R { prod, notes })
            .send().await;
    }
}
`;
  const site = only(await analyzeRustSource(code, [batches()]));
  assert.equal(site.schemaMatch, 'aligned');
  assert.deepEqual(site.resolved!.keys.slice().sort(), ['notes', 'product']);
  assert.ok(site.resolved!.nullableKeys.includes('notes'), 'Option field is nullable');
  assert.ok(!site.resolved!.nullableKeys.includes('product'), 'non-Option field is not nullable');
});

test('variable URL `.patch(&url)` resolves the table from the local `let url = format!(...)`', async () => {
  const code = `
impl Client {
    async fn patch_it(&self, id: &str) {
        let url = format!("{}/rest/v1/batches?id=eq.{}", self.url, id);
        let body = serde_json::json!({ "status": "x" });
        self.client.patch(&url).json(&body).send().await;
    }
}
`;
  const site = only(await analyzeRustSource(code, [batches()]));
  assert.equal(site.table, 'batches');
  assert.equal(site.verb, 'update');
  assert.equal(site.schemaMatch, 'aligned');
});

test('honesty invariants hold across every resolved verdict', async () => {
  const code = `
#[derive(Serialize)]
struct Ins<'a> { id: &'a str, batch_number: &'a str, product: &'a str, status: &'a str, started_at: &'a str, model_version: &'a str }
impl Client {
    async fn a(&self) {
        self.client.post(format!("{}/rest/v1/batches", self.url)).json(&Ins{}).send().await;
    }
    async fn b(&self, id: &str) {
        let body = Self::dynamic();
        self.client.patch(format!("{}/rest/v1/batches?id=eq.{}", self.url, id)).json(&body).send().await;
    }
    fn dynamic() -> serde_json::Value { todo!() }
}
`;
  const sites = await analyzeRustSource(code, [batches()]);
  assert.equal(sites.length, 2);
  for (const s of sites) {
    assert.ok(['aligned', 'mismatch', 'dark'].includes(s.schemaMatch));
    if (s.schemaMatch === 'dark') {
      assert.equal(s.resolved, null);
      assert.equal(s.drift.length, 0);
    } else {
      assert.ok(s.resolved, `${s.schemaMatch} must carry a resolved body`);
    }
    if (s.schemaMatch === 'mismatch') assert.ok(s.drift.length >= 1);
    if (s.schemaMatch === 'aligned') assert.equal(s.drift.length, 0);
    // schemaMatch is its own axis — it is never the string 'verified'.
    assert.notEqual(s.schemaMatch as string, 'verified');
  }
});

function rustTouch(table: string, direction: 'read' | 'write', filePath: string, line: number): GraphNode {
  return {
    id: `touch:rust:${filePath}:${line}:${table}`,
    kind: 'touch',
    language: 'rust',
    label: `${direction} ${table}`,
    trust: 'dark',
    source: { language: 'rust', filePath, startLine: line, endLine: line, snippet: '' },
  };
}

function site(table: string, verb: RustWriteSite['verb'], filePath: string, urlLine: number, schemaMatch: RustWriteSite['schemaMatch']): RustWriteSite {
  return {
    table, verb, urlLine, schemaMatch,
    resolved: schemaMatch === 'dark' ? null : { kind: 'json', keys: [], nullableKeys: [] },
    source: { language: 'rust', filePath, startLine: urlLine, endLine: urlLine, snippet: '' },
    drift: [],
  };
}

test('attachSchemaMatch annotates the right Rust write touches and leaves reads / other languages alone', () => {
  const f = 'src/supabase.rs';
  const insertTouch = rustTouch('batches', 'write', f, 264);
  const recipeTouch = rustTouch('batches', 'write', f, 1652);
  const readTouch = rustTouch('batches', 'read', f, 343);
  const pyTouch: GraphNode = { ...rustTouch('batches', 'write', 'app.py', 10), language: 'python' };
  const touches = [insertTouch, recipeTouch, readTouch, pyTouch];

  attachSchemaMatch(touches, [
    site('batches', 'insert', f, 264, 'aligned'),
    site('batches', 'update', f, 1652, 'dark'),
  ]);

  assert.equal(insertTouch.schemaMatch, 'aligned');
  assert.equal(recipeTouch.schemaMatch, 'dark');
  assert.equal(readTouch.schemaMatch, undefined, 'reads get no schemaMatch');
  assert.equal(pyTouch.schemaMatch, undefined, 'non-Rust touches are untouched');
});

test('attachSchemaMatch tolerates small line offsets but does not cross-assign distant writes', () => {
  const f = 'src/supabase.rs';
  const a = rustTouch('batches', 'write', f, 264);
  const b = rustTouch('batches', 'write', f, 1920);
  attachSchemaMatch([a, b], [
    site('batches', 'insert', f, 266, 'aligned'), // 2 lines off — still the insert
    site('batches', 'update', f, 1920, 'mismatch'),
  ]);
  assert.equal(a.schemaMatch, 'aligned');
  assert.equal(b.schemaMatch, 'mismatch');
});

test('writes to a table with no known contract are ignored', async () => {
  const code = `
impl Client {
    async fn x(&self) {
        self.client.post(format!("{}/rest/v1/unknown_table", self.url)).json(&body).send().await;
    }
}
`;
  const sites = await analyzeRustSource(code, [batches()]);
  assert.equal(sites.length, 0);
});
