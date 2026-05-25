import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ContractColumn, SqlViewRead } from '@throughline/core';
import { parseSchema, parseSql } from './parseSql.js';

// Materialize a throwaway repo with one migration file and parse it.
async function parseMigration(sql: string): Promise<Map<string, ContractColumn>> {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'tl-sql-'));
  try {
    const dir = path.join(repo, 'supabase', 'migrations');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '001_init.sql'), sql);
    const nodes = await parseSql(repo);
    const table = nodes[0];
    return new Map((table.columns ?? []).map((c) => [c.name, c]));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

async function parseMigrationSchema(sql: string): Promise<{ columns: Map<string, ContractColumn>; viewReads: SqlViewRead[] }> {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'tl-sql-'));
  try {
    const dir = path.join(repo, 'supabase', 'migrations');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '001_init.sql'), sql);
    const schema = await parseSchema(repo);
    const table = schema.nodes[0];
    return {
      columns: new Map((table.columns ?? []).map((c) => [c.name, c])),
      viewReads: schema.sqlViewReads,
    };
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

test('parseSql captures DEFAULT clauses from CREATE TABLE as hasDefault', async () => {
  const cols = await parseMigration(`
    create table batches (
      id uuid primary key default gen_random_uuid(),
      batch_number text not null,
      status text not null default 'running',
      started_at timestamptz not null default now(),
      notes text
    );
  `);

  assert.equal(cols.get('id')!.hasDefault, true, 'PK with default()');
  assert.equal(cols.get('status')!.hasDefault, true, "default 'running'");
  assert.equal(cols.get('started_at')!.hasDefault, true, 'default now()');

  assert.ok(!cols.get('batch_number')!.hasDefault, 'NOT NULL, no default');
  assert.ok(!cols.get('notes')!.hasDefault, 'plain nullable column, no default');

  // nullable is still computed as before (additive change).
  assert.equal(cols.get('batch_number')!.nullable, false);
  assert.equal(cols.get('notes')!.nullable, true);
});

test('parseSql captures DEFAULT on ALTER TABLE ADD COLUMN', async () => {
  const cols = await parseMigration(`
    create table t ( id uuid primary key );
    alter table t add column kind text not null default 'x';
    alter table t add column tag text;
  `);

  assert.equal(cols.get('kind')!.hasDefault, true, 'added column with default');
  assert.ok(!cols.get('tag')!.hasDefault, 'added column without default');
});

test('parseSchema extracts grounded SQL view column reads', async () => {
  const { viewReads } = await parseMigrationSchema(`
    create table batches (
      id uuid primary key,
      status text not null,
      analyst_id uuid
    );

    create view v_current_batches as
      select b.id, b.status
      from batches b;
  `);

  assert.equal(viewReads.length, 1);
  assert.equal(viewReads[0].viewName, 'v_current_batches');
  assert.equal(viewReads[0].table, 'batches');
  assert.equal(viewReads[0].confidence, 'certain');
  assert.deepEqual(viewReads[0].columns, ['id', 'status']);
  assert.equal(viewReads[0].source.language, 'sql');
  assert.match(viewReads[0].source.snippet.toLowerCase(), /create view v_current_batches/);
});

test('parseSchema expands single-table SQL view SELECT star into known columns', async () => {
  const { viewReads } = await parseMigrationSchema(`
    create table batches (
      id uuid primary key,
      status text not null,
      analyst_id uuid
    );

    create or replace view v_all_batches as
      select *
      from batches;
  `);

  assert.equal(viewReads.length, 1);
  assert.equal(viewReads[0].confidence, 'certain');
  assert.deepEqual(viewReads[0].columns, ['id', 'status', 'analyst_id']);
});

test('parseSchema expands aliased single-table SQL view SELECT star into known columns', async () => {
  const { viewReads } = await parseMigrationSchema(`
    create table batches (
      id uuid primary key,
      status text not null
    );

    create view v_all_batches as
      select *
      from batches b;
  `);

  assert.equal(viewReads.length, 1);
  assert.equal(viewReads[0].confidence, 'certain');
  assert.deepEqual(viewReads[0].columns, ['id', 'status']);
});


test('parseSchema treats SQL view join predicates as grounded column reads', async () => {
  const { viewReads } = await parseMigrationSchema(`
    create table batches (
      id uuid primary key,
      batch_number text not null
    );
    create table signatures (
      id uuid primary key,
      batch_id uuid not null,
      signer_id uuid not null
    );

    create view v_signed_batches as
      select b.batch_number
      from batches b
      join signatures s on s.batch_id = b.id;
  `);

  const batches = viewReads.find((r) => r.table === 'batches')!;
  const signatures = viewReads.find((r) => r.table === 'signatures')!;
  assert.equal(batches.confidence, 'certain');
  assert.deepEqual(batches.columns, ['batch_number', 'id']);
  assert.equal(signatures.confidence, 'certain');
  assert.deepEqual(signatures.columns, ['batch_id']);
});

test('parseSchema preserves opaque coverage for multi-table SQL view SELECT star mixed with certain reads', async () => {
  const { viewReads } = await parseMigrationSchema(`
    create table batches (
      id uuid primary key,
      batch_number text not null,
      hidden_status text
    );
    create table signatures (
      id uuid primary key,
      batch_id uuid not null,
      signer_id uuid not null
    );

    create view v_mixed_star as
      select *, b.batch_number
      from batches b
      join signatures s on s.batch_id = b.id;
  `);

  const opaqueTables = viewReads
    .filter((r) => r.confidence === 'opaque')
    .map((r) => r.table)
    .sort();
  assert.deepEqual(opaqueTables, ['batches', 'signatures']);
  const batchesCertain = viewReads.find((r) => r.table === 'batches' && r.confidence === 'certain')!;
  assert.deepEqual(batchesCertain.columns, ['batch_number', 'id']);
  const signaturesCertain = viewReads.find((r) => r.table === 'signatures' && r.confidence === 'certain')!;
  assert.deepEqual(signaturesCertain.columns, ['batch_id']);
});

test('parseSchema treats SQL view where predicates as grounded column reads', async () => {
  const { viewReads } = await parseMigrationSchema(`
    create table batches (
      id uuid primary key,
      archived_at timestamptz,
      batch_number text not null
    );

    create view v_active_batches as
      select batch_number
      from batches
      where archived_at is null;
  `);

  assert.equal(viewReads.length, 1);
  assert.equal(viewReads[0].confidence, 'certain');
  assert.deepEqual(viewReads[0].columns, ['batch_number', 'archived_at']);
});

test('parseSchema records opaque SQL view table reads when columns cannot be attributed', async () => {
  const { viewReads } = await parseMigrationSchema(`
    create table batches (
      id uuid primary key,
      status text not null
    );

    create view v_complex_batches as
      with recent as (
        select id from batches
      )
      select *
      from recent;
  `);

  assert.equal(viewReads.length, 1);
  assert.equal(viewReads[0].table, 'batches');
  assert.equal(viewReads[0].confidence, 'opaque');
  assert.equal(viewReads[0].columns, undefined);
  assert.match(viewReads[0].note ?? '', /could not attribute columns/i);
});
