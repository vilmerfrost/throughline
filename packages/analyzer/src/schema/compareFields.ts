import type { ContractColumn, SchemaMatch } from '@throughline/core';

// The ONE field-set comparison shared by every consumer that must agree about
// what "aligns with the schema". The Stage-1a Rust write analyzer
// (rust/schemaMatch.ts) and the MCP `check_write` preventive tool both call this
// so they can NEVER disagree about a verdict.
//
// HONESTY: this compares field NAMES against the schema only — presence and
// unknown keys. It does NOT type-check values (string-vs-uuid etc.); claiming
// that would overclaim. It is a schema-snapshot check, not a runtime or compiler
// guarantee.

export type WriteVerb = 'insert' | 'update' | 'delete';

export interface FieldComparison {
  // Only the two decidable verdicts — `dark` (unresolved payload) is the caller's
  // concern, not this pure name-vs-schema comparison.
  schemaMatch: Exclude<SchemaMatch, 'dark'>;
  missingRequired: string[]; // NOT-NULL-without-default columns absent on insert
  unknownKeys: string[]; // written field names that are not columns
}

// Compare a set of written field names against a table's columns.
//   insert : a column is REQUIRED only when NOT NULL *and has no DEFAULT*
//            (Postgres fills a defaulted column, so omitting it is legal).
//   update : partial writes are fine — nothing is required; only unknown keys flag.
//   delete : same as update for these purposes (no required columns).
export function compareWriteFields(
  fields: string[],
  verb: WriteVerb,
  columns: ContractColumn[],
): FieldComparison {
  const columnNames = new Set(columns.map((c) => c.name));
  const present = new Set(fields);
  const unknownKeys = fields.filter((k) => !columnNames.has(k));
  const missingRequired =
    verb === 'insert'
      ? columns
          .filter((c) => c.nullable === false && !c.hasDefault && !present.has(c.name))
          .map((c) => c.name)
      : [];
  const schemaMatch =
    unknownKeys.length === 0 && missingRequired.length === 0 ? 'aligned' : 'mismatch';
  return { schemaMatch, missingRequired, unknownKeys };
}
