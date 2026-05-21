import { useState, type CSSProperties } from 'react';
import type { ColumnUsage, ColumnUsageVerdict, ContractColumn } from '@throughline/core';
import {
  VERDICT_META,
  summarizeColumnUsage,
  summaryText,
  verdictChip,
  verdictRank,
} from '../lib/columnUsage';
import { SourceLink } from './SourceLink';

interface ColumnUsageListProps {
  columns: ContractColumn[];
  usage: ColumnUsage[];
}

// A faint row tint for the two attention verdicts so the floated block at the
// top reads as one "needs a look" group (amber = goes nowhere, gray = blind).
function rowTint(verdict: ColumnUsageVerdict | undefined): CSSProperties {
  if (verdict === 'likely_dead') {
    return { backgroundColor: 'color-mix(in oklab, var(--color-narrowed) 8%, transparent)' };
  }
  if (verdict === 'unknown') {
    return { backgroundColor: 'color-mix(in oklab, #737373 12%, transparent)' };
  }
  return {};
}

// The contract's column list, annotated with how TypeScript actually reads each
// column. Honesty is the whole point: `used` is the only fact (solid green dot,
// "certain"); every other verdict shows a hollow dot and spells out that it is a
// heuristic. likely_dead + unknown float to the top so dead/unverifiable data is
// visible at a glance. Click a column to see the real evidence behind its verdict.
export function ColumnUsageList({ columns, usage }: ColumnUsageListProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const usageByName = new Map(usage.map((u) => [u.column, u]));
  const rows = columns
    .map((col, order) => ({ col, usage: usageByName.get(col.name), order }))
    .sort((a, b) => {
      const ra = a.usage ? verdictRank(a.usage.verdict) : 2;
      const rb = b.usage ? verdictRank(b.usage.verdict) : 2;
      return ra !== rb ? ra - rb : a.order - b.order;
    });

  const summary = summarizeColumnUsage(usage);

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
          Columns · read usage
        </span>
        <span className="text-[11px] text-neutral-500">
          {summaryText(summary)
            .split(' · ')
            .map((seg, i) => {
              const isDead = seg.includes('no reads found');
              const isUnknown = seg.includes('unverifiable');
              return (
                <span key={i}>
                  {i > 0 ? <span className="text-neutral-700"> · </span> : null}
                  <span
                    style={
                      isDead
                        ? { color: 'var(--color-narrowed)' }
                        : isUnknown
                          ? { color: 'var(--color-text-secondary)' }
                          : undefined
                    }
                  >
                    {seg}
                  </span>
                </span>
              );
            })}
        </span>
      </div>

      <ul className="overflow-hidden rounded-md border border-neutral-800">
        {rows.map(({ col, usage: u }) => {
          const meta = u ? VERDICT_META[u.verdict] : null;
          const isOpen = expanded === col.name;
          const hasEvidence = !!u && u.evidence.length > 0;
          const canOpen = !!u; // every column has at least a note to reveal

          return (
            <li key={col.name} className="border-b border-neutral-800 last:border-0">
              <button
                type="button"
                disabled={!canOpen}
                onClick={() => setExpanded(isOpen ? null : col.name)}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition hover:bg-neutral-800/40 disabled:cursor-default"
                style={rowTint(u?.verdict)}
                aria-expanded={isOpen}
              >
                {meta ? (
                  <span className="h-2 w-2 shrink-0 rounded-full" style={meta.dot} />
                ) : (
                  <span className="h-2 w-2 shrink-0 rounded-full bg-neutral-700" />
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-sm text-neutral-200">
                  {col.name}
                  <span className="ml-2 font-mono text-[11px] text-neutral-500">{col.type}</span>
                </span>

                {meta ? (
                  <span
                    className="shrink-0 text-right font-mono text-[10px] leading-tight"
                    style={{ color: meta.accentVar }}
                  >
                    {verdictChip(u!.verdict)}
                  </span>
                ) : (
                  <span className="shrink-0 font-mono text-[10px] text-neutral-600">no usage data</span>
                )}

                {canOpen ? (
                  <span
                    className="shrink-0 text-neutral-600 transition-transform"
                    style={{ transform: isOpen ? 'rotate(90deg)' : 'none' }}
                  >
                    ›
                  </span>
                ) : null}
              </button>

              {isOpen && u ? (
                <div className="space-y-2 border-t border-neutral-800 bg-black/30 px-3 py-2">
                  <p className="text-xs leading-relaxed text-neutral-400">{u.note}</p>
                  {hasEvidence ? (
                    <ul className="space-y-2">
                      {u.evidence.map((ev, i) => (
                        <li key={i}>
                          <div className="font-mono text-[11px] text-neutral-500">
                            <SourceLink source={ev}>
                              {ev.filePath}:{ev.startLine}
                              {ev.endLine !== ev.startLine ? `-${ev.endLine}` : ''}
                            </SourceLink>
                          </div>
                          <pre className="mt-1 overflow-x-auto rounded border border-neutral-800 bg-black/60 p-2 font-mono text-[11px] leading-relaxed text-neutral-300">
                            {ev.snippet}
                          </pre>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[11px] italic text-neutral-600">
                      No evidence — this verdict rests on the absence of any read.
                    </p>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
