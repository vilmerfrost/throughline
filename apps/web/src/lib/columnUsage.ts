import type { CSSProperties } from 'react';
import type { ColumnUsage, ColumnUsageVerdict } from '@throughline/core';

// Plain-language copy + visual language for the five column-usage verdicts.
// Mirrors trust.ts in spirit: copy is authored verbatim, colors reference the
// shared CSS-var tokens (never raw hex), and the certain-vs-heuristic split is
// encoded VISUALLY (solid dot = certain fact, hollow dot = heuristic / unknown)
// so a column can never be misread as proven when it isn't.
//
// label   — the short status word shown on the column row.
// suffix  — the qualifier ALWAYS shown after the label. Every non-`used`
//           verdict says how it was reached; the heuristics literally say
//           "heuristic" so they never read as fact.
// blurb   — the one-line legend explanation.
export interface VerdictMeta {
  label: string;
  suffix: string;
  certain: boolean;
  highlight: boolean; // floats to the top + gets a tinted row (attention signal)
  dot: CSSProperties; // solid (certain) vs ring (heuristic/unknown)
  accentVar: string; // chip text / highlight color, as a CSS var or token
  blurb: string;
}

const GREEN = 'var(--color-verified)';
const AMBER = 'var(--color-narrowed)';
const GRAY = '#737373'; // neutral-500 — a visible "blind spot" ring on dark bg

const solid = (color: string): CSSProperties => ({ background: color });
const ring = (color: string): CSSProperties => ({
  background: 'transparent',
  border: `1.5px solid ${color}`,
});

export const VERDICT_META: Record<ColumnUsageVerdict, VerdictMeta> = {
  used: {
    label: 'read',
    suffix: 'certain',
    certain: true,
    highlight: false,
    dot: solid(GREEN),
    accentVar: GREEN,
    blurb: 'explicitly selected by name — proven fact.',
  },
  likely_used: {
    label: 'likely read',
    suffix: 'heuristic',
    certain: false,
    highlight: false,
    dot: ring(GREEN),
    accentVar: 'var(--color-text-secondary)',
    blurb: "select('*') result accessed in code — inferred, not proven.",
  },
  likely_rendered: {
    label: 'likely rendered',
    suffix: 'heuristic',
    certain: false,
    highlight: false,
    dot: ring(GREEN),
    accentVar: 'var(--color-text-secondary)',
    blurb: "select('*') result accessed inside JSX — inferred, not proven.",
  },
  likely_dead: {
    label: 'no reads found',
    suffix: 'heuristic',
    certain: false,
    highlight: true,
    dot: solid(AMBER),
    accentVar: AMBER,
    blurb: 'read locally but never accessed — the data may go nowhere.',
  },
  unknown: {
    label: 'usage unknown',
    suffix: "via select('*'), escapes scope",
    certain: false,
    highlight: true,
    dot: ring(GRAY),
    accentVar: 'var(--color-text-secondary)',
    blurb: "select('*') result left local scope — cannot be traced here.",
  },
};

// Legend / list order: best-known fact first, then heuristics, with the two
// attention verdicts (no-reads, unknown) last so the scale reads like the trust
// one. (List SORTING floats those two to the top — see verdictRank.)
export const VERDICT_ORDER: ColumnUsageVerdict[] = [
  'used',
  'likely_used',
  'likely_rendered',
  'likely_dead',
  'unknown',
];

// Float the "needs attention" verdicts (no-reads-found, unverifiable) to the top
// so dead/unknown data is visible at a glance; everything else keeps schema order.
export function verdictRank(verdict: ColumnUsageVerdict): number {
  if (verdict === 'likely_dead') return 0;
  if (verdict === 'unknown') return 1;
  return 2;
}

// The qualifier text shown after the label, e.g. "read · certain".
export function verdictChip(verdict: ColumnUsageVerdict): string {
  const m = VERDICT_META[verdict];
  return `${m.label} · ${m.suffix}`;
}

export interface ColumnUsageSummary {
  total: number;
  certain: number;
  dead: number; // likely_dead
  unknown: number;
}

export function summarizeColumnUsage(usage: ColumnUsage[]): ColumnUsageSummary {
  const summary: ColumnUsageSummary = { total: usage.length, certain: 0, dead: 0, unknown: 0 };
  for (const u of usage) {
    if (u.verdict === 'used') summary.certain += 1;
    else if (u.verdict === 'likely_dead') summary.dead += 1;
    else if (u.verdict === 'unknown') summary.unknown += 1;
  }
  return summary;
}

// "12 columns · 3 no reads found · 2 unverifiable" — segments appear only when
// they carry a count, so the headline stays glanceable.
export function summaryText(summary: ColumnUsageSummary): string {
  const parts = [`${summary.total} ${summary.total === 1 ? 'column' : 'columns'}`];
  if (summary.dead > 0) parts.push(`${summary.dead} no reads found`);
  if (summary.unknown > 0) parts.push(`${summary.unknown} unverifiable`);
  return parts.join(' · ');
}
