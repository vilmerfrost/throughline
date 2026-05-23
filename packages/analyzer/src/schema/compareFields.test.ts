import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContractColumn } from '@throughline/core';
import { compareWriteFields } from './compareFields.js';

// A small schema exercising every relevant column shape:
//  - id:        NOT NULL, has DEFAULT  → optional on insert (default fills it)
//  - org_id:    NOT NULL, no DEFAULT   → REQUIRED on insert
//  - label:     NOT NULL, no DEFAULT   → REQUIRED on insert
//  - note:      nullable               → optional everywhere
const columns: ContractColumn[] = [
  { name: 'id', type: 'uuid', nullable: false, hasDefault: true },
  { name: 'org_id', type: 'uuid', nullable: false },
  { name: 'label', type: 'text', nullable: false },
  { name: 'note', type: 'text', nullable: true },
];

test('insert: all required present (defaulted col omitted) → aligned', () => {
  const r = compareWriteFields(['org_id', 'label'], 'insert', columns);
  assert.equal(r.schemaMatch, 'aligned');
  assert.deepEqual(r.missingRequired, []);
  assert.deepEqual(r.unknownKeys, []);
});

test('insert: omitting a NOT-NULL-no-default column → mismatch + missingRequired', () => {
  const r = compareWriteFields(['org_id'], 'insert', columns);
  assert.equal(r.schemaMatch, 'mismatch');
  assert.deepEqual(r.missingRequired, ['label']);
  assert.deepEqual(r.unknownKeys, []);
});

test('insert: omitting only a NOT-NULL-WITH-default column → aligned (default covers it)', () => {
  const r = compareWriteFields(['org_id', 'label', 'note'], 'insert', columns);
  assert.equal(r.schemaMatch, 'aligned');
  assert.deepEqual(r.missingRequired, []);
});

test('insert: unknown key → mismatch + unknownKeys (names only)', () => {
  const r = compareWriteFields(['org_id', 'label', 'previous_hash'], 'insert', columns);
  assert.equal(r.schemaMatch, 'mismatch');
  assert.deepEqual(r.unknownKeys, ['previous_hash']);
  assert.deepEqual(r.missingRequired, []);
});

test('update: never flags missing required columns (partial write is fine)', () => {
  const r = compareWriteFields(['note'], 'update', columns);
  assert.equal(r.schemaMatch, 'aligned');
  assert.deepEqual(r.missingRequired, []);
});

test('update: still flags unknown keys', () => {
  const r = compareWriteFields(['note', 'bogus'], 'update', columns);
  assert.equal(r.schemaMatch, 'mismatch');
  assert.deepEqual(r.unknownKeys, ['bogus']);
  assert.deepEqual(r.missingRequired, []);
});

test('delete: behaves like a non-insert — no required columns, only unknown keys flagged', () => {
  const ok = compareWriteFields(['id'], 'delete', columns);
  assert.equal(ok.schemaMatch, 'aligned');
  const bad = compareWriteFields(['nope'], 'delete', columns);
  assert.equal(bad.schemaMatch, 'mismatch');
  assert.deepEqual(bad.unknownKeys, ['nope']);
});
