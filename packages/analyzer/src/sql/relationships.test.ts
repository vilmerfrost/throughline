import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Relationship } from '@throughline/core';
import { parseSchema } from './parseSql.js';

// Materialize a repo whose supabase/migrations dir holds the given files (name →
// SQL), run the schema parser, and return just the declared relationships.
async function relationshipsFrom(files: Record<string, string>): Promise<Relationship[]> {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'tl-fk-'));
  try {
    const dir = path.join(repo, 'supabase', 'migrations');
    await mkdir(dir, { recursive: true });
    for (const [name, sql] of Object.entries(files)) {
      await writeFile(path.join(dir, name), sql);
    }
    const { relationships } = await parseSchema(repo);
    return relationships;
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

// Convenience: a single migration file.
function one(sql: string): Promise<Relationship[]> {
  return relationshipsFrom({ '001_init.sql': sql });
}

test('extracts an inline column-level REFERENCES as a relationship', async () => {
  const rels = await one(`
    create table parent (id uuid primary key);
    create table child (
      id uuid primary key,
      parent_id uuid not null references parent(id)
    );
  `);
  assert.equal(rels.length, 1);
  const fk = rels[0];
  assert.equal(fk.fromTable, 'child');
  assert.equal(fk.fromColumn, 'parent_id');
  assert.equal(fk.toTable, 'parent');
  assert.equal(fk.toColumn, 'id');
  assert.equal(fk.cardinality, 'many-to-one');
});

test('extracts a table-level FOREIGN KEY constraint', async () => {
  const rels = await one(`
    create table parent (id uuid primary key);
    create table child (
      id uuid primary key,
      parent_id uuid not null,
      foreign key (parent_id) references parent(id)
    );
  `);
  assert.equal(rels.length, 1);
  assert.deepEqual(
    { from: `${rels[0].fromTable}.${rels[0].fromColumn}`, to: `${rels[0].toTable}.${rels[0].toColumn}` },
    { from: 'child.parent_id', to: 'parent.id' },
  );
});

test('extracts an ALTER TABLE ... ADD CONSTRAINT foreign key, grounded in the ALTER migration', async () => {
  const rels = await relationshipsFrom({
    '001_tables.sql': `
      create table parent (id uuid primary key);
      create table child (id uuid primary key, parent_id uuid not null);
    `,
    '002_fk.sql': `
      alter table child
        add constraint child_parent_fk foreign key (parent_id) references parent(id);
    `,
  });
  assert.equal(rels.length, 1);
  assert.equal(rels[0].fromTable, 'child');
  assert.equal(rels[0].toTable, 'parent');
  // Grounded in the migration that declares the FK — the ALTER, not the CREATE.
  assert.equal(rels[0].source.filePath, 'supabase/migrations/002_fk.sql');
  assert.match(rels[0].source.snippet.toLowerCase(), /alter table[\s\S]*references parent/);
});

test('infers one-to-one when the FK column is itself UNIQUE', async () => {
  const rels = await one(`
    create table users (id uuid primary key);
    create table profile (
      id uuid primary key,
      user_id uuid not null unique references users(id)
    );
  `);
  assert.equal(rels.length, 1);
  assert.equal(rels[0].cardinality, 'one-to-one');
});

test('infers one-to-one when the FK column is itself the PRIMARY KEY', async () => {
  const rels = await one(`
    create table users (id uuid primary key);
    create table account (
      user_id uuid primary key references users(id),
      balance numeric
    );
  `);
  assert.equal(rels.length, 1);
  assert.equal(rels[0].cardinality, 'one-to-one');
});

test('infers one-to-one from a single-column table-level UNIQUE constraint', async () => {
  const rels = await one(`
    create table users (id uuid primary key);
    create table profile (
      id uuid primary key,
      user_id uuid not null references users(id),
      unique (user_id)
    );
  `);
  assert.equal(rels.length, 1);
  assert.equal(rels[0].cardinality, 'one-to-one');
});

test('a composite UNIQUE does NOT make a single FK column one-to-one', async () => {
  const rels = await one(`
    create table users (id uuid primary key);
    create table membership (
      id uuid primary key,
      user_id uuid not null references users(id),
      org_id uuid not null,
      unique (user_id, org_id)
    );
  `);
  assert.equal(rels.length, 1);
  assert.equal(rels[0].cardinality, 'many-to-one');
});

test('skips a column-less REFERENCES (parser-unsupported) rather than fabricating a target column', async () => {
  // `REFERENCES parent` with no column list is valid Postgres but pgsql-ast-parser
  // rejects it, so the whole statement fails to parse and is skipped. The honest
  // outcome is to emit nothing — never invent the target column.
  const rels = await one(`
    create table parent (id uuid primary key);
    create table child (
      id uuid primary key,
      parent_id uuid not null references parent
    );
  `);
  assert.deepEqual(rels, []);
});

test('emits a relationship for an unresolved target as declared, never fabricating it', async () => {
  const rels = await one(`
    create table child (
      id uuid primary key,
      ghost_id uuid not null references ghost(ref)
    );
  `);
  assert.equal(rels.length, 1);
  assert.equal(rels[0].toTable, 'ghost');
  assert.equal(rels[0].toColumn, 'ref');
});

test('emits nothing for tables with no foreign keys (no semantic inference)', async () => {
  const rels = await one(`
    create table a (id uuid primary key, label text);
    create table b (id uuid primary key, label text);
  `);
  assert.deepEqual(rels, []);
});

test('grounds every relationship in a real REFERENCES on disk', async () => {
  const rels = await one(`
    create table parent (id uuid primary key);
    create table child (id uuid primary key, parent_id uuid references parent(id));
  `);
  assert.equal(rels.length, 1);
  assert.equal(rels[0].source.language, 'sql');
  assert.ok(rels[0].source.startLine >= 1);
  assert.match(rels[0].source.snippet.toLowerCase(), /references parent/);
});

test('emits one relationship per column pair for a composite foreign key', async () => {
  const rels = await one(`
    create table parent (a uuid, b uuid, primary key (a, b));
    create table child (
      id uuid primary key,
      pa uuid not null,
      pb uuid not null,
      foreign key (pa, pb) references parent(a, b)
    );
  `);
  assert.equal(rels.length, 2);
  const pairs = rels.map((r) => `${r.fromColumn}->${r.toColumn}`).sort();
  assert.deepEqual(pairs, ['pa->a', 'pb->b']);
  // Composite FK: never overclaim one-to-one per column.
  assert.ok(rels.every((r) => r.cardinality === 'many-to-one'));
});

test('parseSchema still returns the contract nodes alongside relationships', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'tl-fk-'));
  try {
    const dir = path.join(repo, 'supabase', 'migrations');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, '001_init.sql'),
      `create table parent (id uuid primary key);
       create table child (id uuid primary key, parent_id uuid references parent(id));`,
    );
    const { nodes, relationships } = await parseSchema(repo);
    assert.equal(nodes.length, 2);
    assert.ok(nodes.every((n) => n.kind === 'contract'));
    assert.equal(relationships.length, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
