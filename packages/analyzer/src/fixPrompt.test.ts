import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { GraphNode } from '@throughline/core';
import { buildFixPrompt } from './fixPrompt.js';
import type { ExplainContext } from './explain.js';

const tsCastTouch: GraphNode = {
  id: 'touch:ts:src/batches.ts:12:batches',
  kind: 'touch',
  label: 'write batches',
  language: 'typescript',
  trust: 'asserted',
  trustReason: 'ts-cast-concrete',
  notes: 'Write of `batches`, result cast `as Batch` — asserted, not verified.',
  source: {
    language: 'typescript',
    filePath: 'src/batches.ts',
    startLine: 12,
    endLine: 14,
    snippet: 'const batch = payload as Batch;',
  },
};

const baseContext: ExplainContext = {
  repoPath: '/repo/example',
  contract: {
    table: 'batches',
    columns: [
      { name: 'id', type: 'uuid', nullable: false },
      { name: 'status', type: 'text', nullable: false },
    ],
    source: {
      language: 'sql',
      filePath: 'supabase/migrations/001.sql',
      startLine: 1,
      endLine: 6,
      snippet: 'create table batches (...)',
    },
  },
};

test('buildFixPrompt produces a code-fix brief for TypeScript cast asserts', () => {
  const fix = buildFixPrompt(tsCastTouch, baseContext);

  assert.equal(fix.kind, 'code-fix');
  assert.match(fix.prompt, /src\/batches\.ts:12-14/);
  assert.match(fix.prompt, /batches/);
  assert.match(fix.prompt, /id: uuid not null/);
  assert.match(fix.prompt, /Acceptance/);
});

test('buildFixPrompt is agent-friendly: no Throughline / trust-dot jargon', () => {
  const fix = buildFixPrompt(tsCastTouch, baseContext);

  assert.doesNotMatch(fix.prompt, /Throughline/i);
  assert.doesNotMatch(fix.prompt, /trust dot/i);
  assert.doesNotMatch(fix.prompt, /trustReason/i);
});

test('buildFixPrompt is multi-track for Python shallow-grep, with both code and system tracks', () => {
  const pyTouch: GraphNode = {
    id: 'touch:py:edge/api.py:10:batches',
    kind: 'touch',
    label: 'write batches',
    language: 'python',
    trust: 'dark',
    trustReason: 'shallow-grep-python',
    source: {
      language: 'python',
      filePath: 'edge/api.py',
      startLine: 10,
      endLine: 10,
      snippet: 'supabase.table("batches").insert(payload)',
    },
  };

  const fix = buildFixPrompt(pyTouch, baseContext);

  assert.equal(fix.kind, 'code-fix');
  assert.match(fix.prompt, /Track A/);
  assert.match(fix.prompt, /Track B/);
  assert.match(fix.prompt, /Pydantic|TypedDict/);
  assert.doesNotMatch(fix.prompt, /Throughline/i);
  assert.doesNotMatch(fix.prompt, /trust dot/i);
});

test('buildFixPrompt notes verified touches need no fix', () => {
  const verifiedTouch: GraphNode = {
    ...tsCastTouch,
    trust: 'verified',
    trustReason: 'ts-verified',
  };

  const fix = buildFixPrompt(verifiedTouch, baseContext);

  assert.equal(fix.kind, 'no-fix-needed');
  assert.match(fix.prompt, /already statically verified|no change required/i);
});

test('buildFixPrompt handles aggregate selection with multiple constituent touches', () => {
  const aggregateNode: GraphNode = {
    id: 'aggregate:ts-cast-concrete',
    kind: 'touch',
    label: 'TS write ×3',
    trust: 'asserted',
    trustReason: 'ts-cast-concrete',
  };

  const aggregateContext: ExplainContext = {
    ...baseContext,
    touches: [
      {
        language: 'typescript',
        direction: 'write',
        trust: 'asserted',
        source: {
          language: 'typescript',
          filePath: 'src/batches.ts',
          startLine: 12,
          endLine: 14,
          snippet: 'const batch = payload as Batch;',
        },
      },
      {
        language: 'typescript',
        direction: 'write',
        trust: 'asserted',
        source: {
          language: 'typescript',
          filePath: 'src/jobs.ts',
          startLine: 45,
          endLine: 45,
          snippet: 'const job = payload as Job;',
        },
      },
      {
        language: 'typescript',
        direction: 'write',
        trust: 'asserted',
        // This touch has no source
      },
    ],
  };

  const fix = buildFixPrompt(aggregateNode, aggregateContext);

  assert.equal(fix.kind, 'code-fix');
  // Check that both real sources are listed under Files to change
  assert.match(fix.prompt, /src\/batches\.ts:12-14/);
  assert.match(fix.prompt, /src\/jobs\.ts:45/);
  // Check that the touch without a source falls back to @unknown source
  assert.match(fix.prompt, /@unknown source/);
  // Ensure we didn't lose other fields
  assert.match(fix.prompt, /batches/);
  assert.match(fix.prompt, /id: uuid not null/);
});
