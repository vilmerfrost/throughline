import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { GraphNode } from '@throughline/core';
import { sqlWriters } from './writers.js';

// Materialize a tiny repo whose `supabase/` tree holds the given files, run
// the SQL writer pass, and return the touches it produced.
async function run(files: Record<string, string>, contracts: GraphNode[]) {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'tl-sqlw-'));
  try {
    for (const [rel, sql] of Object.entries(files)) {
      const abs = path.join(repo, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, sql);
    }
    return await sqlWriters(repo, contracts);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

function contract(table: string): GraphNode {
  return { id: `contract:${table}`, kind: 'contract', label: table };
}

test('INSERT INTO inside a migration is emitted as a migration writer touch', async () => {
  const out = await run(
    {
      'supabase/migrations/002_backfill.sql': `
        insert into adapter_runs (id, status) values ('a', 'queued');
      `,
    },
    [contract('adapter_runs')],
  );
  assert.equal(out.nodes.length, 1);
  const touch = out.nodes[0];
  assert.equal(touch.lifecycle, 'migration');
  assert.equal(touch.analysisDepth, 'shallow');
  assert.equal(touch.trust, 'dark');
  assert.equal(touch.trustReason, 'shallow-grep-sql');
  assert.equal(touch.label, 'write adapter_runs');
  assert.equal(touch.source?.filePath, 'supabase/migrations/002_backfill.sql');
  assert.match(touch.notes ?? '', /migration/);
});

test('line-commented DML in a migration is ignored', async () => {
  const out = await run(
    {
      'supabase/migrations/004_comment_only.sql': `
        -- insert into adapter_runs (id) values ('a');
      `,
    },
    [contract('adapter_runs')],
  );
  assert.equal(out.nodes.length, 0);
});

test('block-commented DML in a migration is ignored', async () => {
  const out = await run(
    {
      'supabase/migrations/005_block_comment_only.sql': `
        /*
          update adapter_runs set status = 'done';
          delete from adapter_runs where id = 'a';
        */
      `,
    },
    [contract('adapter_runs')],
  );
  assert.equal(out.nodes.length, 0);
});

test('INSERT/UPDATE/DELETE inside a $function$ body are labelled as trigger writers', async () => {
  const out = await run(
    {
      'supabase/migrations/003_triggers.sql': `
        create or replace function audit_run()
        returns trigger language plpgsql as $function$
        begin
          insert into audit_log (event) values ('updated');
          update adapter_runs set status = 'logged' where id = new.id;
          return new;
        end;
        $function$;
      `,
    },
    [contract('audit_log'), contract('adapter_runs')],
  );
  assert.equal(out.nodes.length, 2);
  for (const n of out.nodes) {
    assert.equal(n.lifecycle, 'trigger', `expected trigger lifecycle for ${n.label}`);
  }
});

test('seed file writes are emitted with lifecycle seed (NOT migration)', async () => {
  const out = await run(
    {
      'supabase/seed.sql': `insert into batches (id) values ('a');`,
    },
    [contract('batches')],
  );
  assert.equal(out.nodes.length, 1);
  assert.equal(out.nodes[0].lifecycle, 'seed');
});

test('writes against unknown tables are ignored (never fabricates a contract)', async () => {
  const out = await run(
    {
      'supabase/migrations/001.sql': `insert into ghost_table (id) values ('a');`,
    },
    [contract('adapter_runs')],
  );
  assert.equal(out.nodes.length, 0);
});

test('files outside supabase/ are not scanned', async () => {
  const out = await run(
    {
      'app/db/backfill.sql': `insert into adapter_runs (id) values ('a');`,
    },
    [contract('adapter_runs')],
  );
  assert.equal(out.nodes.length, 0);
});
