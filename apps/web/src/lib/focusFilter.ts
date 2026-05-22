import type { ColumnReach } from '@throughline/core';
import type { Verdict } from './trust';
import type { ContractSummary } from './focus';

// Client-side triage filter for the focus view, shared by two surfaces:
//   - the contract list (left rail) — keep contracts that match a chip;
//   - within the selected contract — verdict chips filter the rendered touches,
//     reach chips filter the rendered columns.
// It never touches the analyzer/graph — it's a pure view over the existing data.

// Verdict chips, worst -> best (this is the verdict the contract dot already
// computes — the WORST touch verdict).
export const FILTER_VERDICTS: Verdict[] = [
  'mismatch',
  'dark',
  'asserted',
  'narrowed',
  'aligned',
  'verified',
];

// "Columns present" chips — only the three stored-but-not-shown / blind reach
// states are useful for triage (ui_shown is the resolved/good state).
export type FilterReach = Exclude<ColumnReach, 'ui_shown'>;
export const FILTER_REACHES: FilterReach[] = ['never_read', 'server_only', 'unknown'];

// Short chip label for each reach state ("has-…" framing per the triage intent).
export const REACH_FILTER_LABEL: Record<FilterReach, string> = {
  never_read: 'has-no-reader',
  server_only: 'has-not-shown',
  unknown: 'has-untraceable',
};

export interface FocusFilterState {
  verdicts: Set<Verdict>;
  reaches: Set<ColumnReach>;
  // RC-b: an explicit allowlist of contract LABELS, set when a root cause is
  // clicked in the Root Causes view to scope the list to its affected contracts.
  // Empty = no scope. Mutually exclusive with chips in practice (toggling a chip
  // clears the scope), so it acts as a focused lens rather than another OR clause.
  contracts: Set<string>;
}

export function emptyFocusFilter(): FocusFilterState {
  return { verdicts: new Set(), reaches: new Set(), contracts: new Set() };
}

export function isFocusFilterActive(f: FocusFilterState): boolean {
  return f.verdicts.size > 0 || f.reaches.size > 0 || f.contracts.size > 0;
}

// Contract-list predicate. A root-cause contract scope is an explicit allowlist
// and takes precedence; otherwise OR across every selected chip (a contract
// shows if it matches ANY active chip). No filter active = everything passes.
export function contractPasses(s: ContractSummary, f: FocusFilterState): boolean {
  if (!isFocusFilterActive(f)) return true;
  if (f.contracts.size > 0) return f.contracts.has(s.label);
  if (s.verdict && f.verdicts.has(s.verdict)) return true;
  for (const r of f.reaches) if (s.reach[r] > 0) return true;
  return false;
}
