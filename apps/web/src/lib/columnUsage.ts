import type { CSSProperties } from 'react';
import type { ColumnReach, ColumnUsage } from '@throughline/core';

// Plain-language copy + visual language for the column READ-REACH axis (B2).
// Reach is the ONE per-column status — where the column's value actually
// travels — and it supersedes the older usage verdict. Confidence stays encoded
// VISUALLY in the same grammar as trust: a SOLID dot = a certain fact, a HOLLOW
// (ring) dot = a heuristic, so a column can never be misread as proven when it
// isn't. Colors reference the shared CSS-var tokens, never raw hex.
//
// Honesty is load-bearing in the copy:
//   - never_read says "no reader found" and ALWAYS carries the unscanned-language
//     hedge — it is never "dead" or "deletable".
//   - unknown says "can't trace" and is framed as a blind spot to resolve (type
//     the client), never as "not shown".

const GREEN = 'var(--color-verified)'; // shown to a user
const BLUE = 'var(--color-edge-read)'; // read, but server-side (echoes the read-edge color)
const AMBER = 'var(--color-narrowed)'; // attention: no reader found (hedged, not alarming)
const GRAY = '#737373'; // neutral-500 — a visible "blind spot" ring on the dark bg

export interface ReachMeta {
  label: string; // the status phrase shown on the column row
  hedge?: string; // honesty caveat for never_read / unknown (shown in the expansion + legend)
  color: string; // dot + chip color, as a CSS var or token
  highlight: boolean; // floats up + gets a faint row tint (the stored-but-not-shown signal)
  blurb: string; // one-line legend explanation
}

export const REACH_META: Record<ColumnReach, ReachMeta> = {
  ui_shown: {
    label: 'shown in UI',
    color: GREEN,
    highlight: false,
    blurb: 'a read resolves to a property access inside JSX — rendered to a user.',
  },
  server_only: {
    label: 'used outside scanned UI',
    color: BLUE,
    highlight: true,
    hedge: 'read by TypeScript server code or SQL views, but not observed inside scanned JSX.',
    blurb: 'read outside scanned JSX — used, but not proven shown to a user.',
  },
  never_read: {
    label: 'no scanned reader found',
    color: AMBER,
    highlight: true,
    hedge: "no scanned reader found; Python/Rust/raw SQL/external agents may still read it. Not a deletion signal.",
    blurb: 'no scanned reader found — may still be read elsewhere (not “dead”).',
  },
  unknown: {
    label: 'reader exists · path opaque',
    color: GRAY,
    highlight: false,
    hedge: 'a reader exists, but the path is opaque: untyped TypeScript flow or a SQL view whose exact columns could not be attributed.',
    blurb: 'a reader exists but the path is opaque — can’t tell where the value goes.',
  },
};

// Legend order: shown first (the resolved/good state), then the two stored-but-
// not-shown states, then the blind spot.
export const REACH_ORDER: ColumnReach[] = ['ui_shown', 'server_only', 'never_read', 'unknown'];

// A column with no reach data (old payloads / pre-B1) is honestly a blind spot.
export function reachOf(u: ColumnUsage | undefined): ColumnReach {
  return u?.reach ?? 'unknown';
}

// LIST sorting: float the "stored but not shown" signal (no-reader, then
// server-only) to the very top, the blind spot below it, and the fully-resolved
// shown columns last. So scanning the top of the list surfaces the insight.
export function reachRank(reach: ColumnReach): number {
  switch (reach) {
    case 'never_read':
      return 0;
    case 'server_only':
      return 1;
    case 'unknown':
      return 2;
    case 'ui_shown':
      return 3;
  }
}

// Solid dot = certain (an explicitly-named read); ring = heuristic/untraceable.
export function reachDot(reach: ColumnReach, certain: boolean): CSSProperties {
  const c = REACH_META[reach].color;
  return certain ? { background: c } : { background: 'transparent', border: `1.5px solid ${c}` };
}

export interface ReachSummary {
  total: number;
  ui_shown: number;
  server_only: number;
  never_read: number;
  unknown: number;
}

export function summarizeReach(usage: ColumnUsage[]): ReachSummary {
  const s: ReachSummary = { total: usage.length, ui_shown: 0, server_only: 0, never_read: 0, unknown: 0 };
  for (const u of usage) s[reachOf(u)] += 1;
  return s;
}

// The contract headline: "N shown · M server-only · K no-reader · U untraceable".
// Returned as colorable segments (one per reach state) so the consumer can tint
// each count with its reach token.
export interface ReachSegment {
  reach: ColumnReach;
  count: number;
  label: string;
}
export function reachSummarySegments(s: ReachSummary): ReachSegment[] {
  return [
    { reach: 'ui_shown', count: s.ui_shown, label: 'shown' },
    { reach: 'server_only', count: s.server_only, label: 'outside-UI' },
    { reach: 'never_read', count: s.never_read, label: 'no scanned reader' },
    { reach: 'unknown', count: s.unknown, label: 'opaque' },
  ];
}
