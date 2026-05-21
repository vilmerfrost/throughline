import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { GraphNode } from '@throughline/core';
import {
  buildFileUri,
  buildUserMessage,
  collectResearchSources,
  parseExplanation,
  type ExplainContext,
} from './explain.js';

const touchNode: GraphNode = {
  id: 'touch:src/batches.ts:1',
  kind: 'touch',
  label: 'insert batches',
  language: 'typescript',
  trust: 'asserted',
  source: {
    language: 'typescript',
    filePath: 'src/batches.ts',
    startLine: 12,
    endLine: 14,
    snippet: 'const batch = payload as Batch;',
  },
};

test('buildFileUri creates clickable file links with line numbers', () => {
  assert.equal(
    buildFileUri('/repo/example', touchNode.source!),
    'cursor://file//repo/example/src/batches.ts:12',
  );
});

test('collectResearchSources returns focused linked sources', () => {
  const context: ExplainContext = {
    repoPath: '/repo/example',
    mode: 'focused',
    contract: {
      table: 'batches',
      source: {
        language: 'sql',
        filePath: 'supabase/migrations/001.sql',
        startLine: 1,
        endLine: 6,
        snippet: 'create table batches (id uuid primary key);',
      },
    },
  };

  const sources = collectResearchSources(touchNode, context);

  assert.equal(sources.length, 2);
  assert.equal(sources[0]?.filePath, 'src/batches.ts');
  assert.equal(sources[0]?.uri, 'cursor://file//repo/example/src/batches.ts:12');
  assert.equal(sources[1]?.filePath, 'supabase/migrations/001.sql');
});

test('collectResearchSources includes aggregate touches without a selected node source', () => {
  const aggregateNode: GraphNode = {
    id: 'aggregate:typescript:read:batches',
    kind: 'touch',
    label: 'TypeScript reads batches',
    language: 'typescript',
    trust: 'verified',
  };
  const context: ExplainContext = {
    repoPath: '/repo/example',
    mode: 'focused',
    touches: [
      {
        language: 'typescript',
        direction: 'read',
        trust: 'verified',
        source: touchNode.source,
      },
    ],
  };

  const sources = collectResearchSources(aggregateNode, context);

  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.filePath, 'src/batches.ts');
});

test('buildUserMessage pins the user question and injects the trust model', () => {
  const context: ExplainContext = {
    repoPath: '/repo/example',
    mode: 'repo',
    userPrompt: 'How do I make these green?',
    drift: ['batches has asserted writes from TypeScript'],
  };

  const message = buildUserMessage(touchNode, context);

  assert.match(message, /PRIMARY USER QUESTION/);
  assert.match(message, /How do I make these green\?/);
  assert.match(message, /Throughline trust model/);
  assert.match(message, /python: shallow/);
  assert.match(message, /Research mode: repo/);
  assert.match(message, /Drift findings/);
});

test('buildUserMessage surfaces the analyzer trust reason when present', () => {
  const pythonTouch: GraphNode = {
    id: 'touch:py:edge/api.py:1',
    kind: 'touch',
    label: 'write batches',
    language: 'python',
    trust: 'dark',
    trustReason: 'shallow-grep-python',
    source: {
      language: 'python',
      filePath: 'edge/api.py',
      startLine: 10,
      endLine: 12,
      snippet: 'supabase.table("batches").insert(payload)',
    },
  };
  const context: ExplainContext = {
    repoPath: '/repo/example',
    mode: 'focused',
    userPrompt: 'why is this dark?',
  };

  const message = buildUserMessage(pythonTouch, context);

  assert.match(message, /Trust reason \(analyzer\): shallow-grep-python/);
  assert.match(message, /Python is shallow-grep only/);
  assert.match(message, /Tag each Recommended next action as \(code\)/);
});

test('parseExplanation strips code fences and reasoning prefixes from sections', () => {
  const explanation = parseExplanation(`Recap
\`\`\`
Wait, let's look at the columns in the SQL schema provided in the prompt:
- progress_pct smallint NOT NULL
\`\`\`

What this is
The read targets inspection_packs.

Evidence
- [src/file.ts:12] reads inspection_packs.

Risk / confidence
Unknown shape. Confidence: medium.

Recommended next actions
- Verify the generated type.

Conclusion
Treat as blind until verified.`);

  assert.equal(
    explanation.recap,
    '- progress_pct smallint NOT NULL',
    'recap should drop the code fences and the "Wait, let me" thinking line',
  );
  assert.equal(explanation.what, 'The read targets inspection_packs.');
});

test('parseExplanation extracts structured sections from model output', () => {
  const explanation = parseExplanation(`Recap
This is a dark TypeScript read because the analyzer found unchecked code.

What this is
The read touches inspection_packs.

Evidence
- [app/api/route.ts:12] uses maybeSingle().

Risk / confidence
The exact runtime shape is unknown. Confidence: medium.

Recommended next actions
- Check the generated type for inspection_packs.

Conclusion
Treat this as a typing blind spot until verified.`);

  assert.equal(explanation.recap, 'This is a dark TypeScript read because the analyzer found unchecked code.');
  assert.equal(explanation.what, 'The read touches inspection_packs.');
  assert.match(explanation.evidence, /maybeSingle/);
  assert.match(explanation.risk, /unknown/);
  assert.match(explanation.actions, /generated type/);
  assert.equal(explanation.conclusion, 'Treat this as a typing blind spot until verified.');
});
