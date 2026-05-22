import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ContractColumn } from '@throughline/core';
import { parseSql } from './parseSql.js';

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
