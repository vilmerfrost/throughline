import { useState, type CSSProperties } from 'react';
import type { ColumnReach, ColumnUsage, ContractColumn } from '@throughline/core';
import {
  REACH_META,
  reachDot,
  reachOf,
  reachRank,
  reachSummarySegments,
  summarizeReach,
} from '../lib/columnUsage';
import { SourceLink } from './SourceLink';

interface ColumnUsageListProps {
  columns: ContractColumn[];
  usage: ColumnUsage[];
  // When non-empty, only columns whose reach is in this set are listed (the
  // within-contract reach filter). The headline summary still reflects the full
  // column set so the totals stay honest.
  reachFilter?: Set<ColumnReach>;
}

// A faint row tint for the "stored but not shown" signals so the floated block
// at the top reads as one group: amber = no reader found, blue = used but not
// shown, gray = blind spot we can't trace.
function rowTint(reach: ColumnReach): CSSProperties {
  switch (reach) {
    case 'never_read':
      return { backgroundColor: 'color-mix(in oklab, var(--color-narrowed) 9%, transparent)' };
    case 'server_only':
      return { backgroundColor: 'color-mix(in oklab, var(--color-edge-read) 7%, transparent)' };
    case 'unknown':
      return { backgroundColor: 'color-mix(in oklab, #737373 12%, transparent)' };
    default:
      return {};
  }
}

// The contract's columns, annotated with how each one's value actually travels —
// the reach axis. Reach is the ONE status: shown in UI, used server-side but not
// shown, no reader found, or untraceable. The filled/hollow dot keeps the same
// confidence grammar as trust (solid = certain fact, hollow = heuristic). The
// stored-but-not-shown columns (no-reader, then server-only) float to the top so
// the signal is visible at a glance. Click a column for the grounding — the
// reads behind the verdict, or, for an untraceable column, the escape-trail.
export function ColumnUsageList({ columns, usage, reachFilter }: ColumnUsageListProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const usageByName = new Map(usage.map((u) => [u.column, u]));
  const filtering = reachFilter && reachFilter.size > 0;
  const rows = columns
    .map((col, order) => ({ col, usage: usageByName.get(col.name), order }))
    .filter(({ usage: u }) => !filtering || reachFilter!.has(reachOf(u)))
    .sort((a, b) => {
      const ra = reachRank(reachOf(a.usage));
      const rb = reachRank(reachOf(b.usage));
      return ra !== rb ? ra - rb : a.order - b.order;
    });

  const segments = reachSummarySegments(summarizeReach(usage));

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
          Columns · read reach
        </span>
        <span className="text-[11px]">
          {segments.map((seg, i) => (
            <span key={seg.reach}>
              {i > 0 ? <span className="text-neutral-700"> · </span> : null}
              <span style={{ color: seg.count > 0 ? REACH_META[seg.reach].color : '#525252' }}>
                {seg.count} {seg.label}
              </span>
            </span>
          ))}
        </span>
      </div>

      {filtering && rows.length === 0 ? (
        <div className="rounded-md border border-neutral-800 px-2.5 py-3 text-center text-[11px] text-neutral-600">
          No columns match the reach filter.
        </div>
      ) : (
      <ul className="overflow-hidden rounded-md border border-neutral-800">
        {rows.map(({ col, usage: u }) => {
          const reach = reachOf(u);
          const meta = REACH_META[reach];
          const isOpen = expanded === col.name;
          const canOpen = !!u;
          const trail = u?.escapeTrail ?? [];
          const hasTrail = reach === 'unknown' && trail.length > 0;

          return (
            <li key={col.name} className="border-b border-neutral-800 last:border-0">
              <button
                type="button"
                disabled={!canOpen}
                onClick={() => setExpanded(isOpen ? null : col.name)}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition hover:bg-neutral-800/40 disabled:cursor-default"
                style={rowTint(reach)}
                aria-expanded={isOpen}
              >
                {u ? (
                  <span className="h-2 w-2 shrink-0 rounded-full" style={reachDot(reach, u.certain)} />
                ) : (
                  <span className="h-2 w-2 shrink-0 rounded-full bg-neutral-700" />
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-sm text-neutral-200">
                  {col.name}
                  <span className="ml-2 font-mono text-[11px] text-neutral-500">{col.type}</span>
                </span>

                {u ? (
                  <span className="flex shrink-0 flex-col items-end leading-tight">
                    <span className="font-mono text-[10px]" style={{ color: meta.color }}>
                      {meta.label}
                    </span>
                    <span className="font-mono text-[10px] text-neutral-600">
                      {u.certain ? 'certain' : 'heuristic'}
                    </span>
                  </span>
                ) : (
                  <span className="shrink-0 font-mono text-[10px] text-neutral-600">no reach data</span>
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
                  {/* Honesty caveat for the hedged states (no-reader, untraceable). */}
                  {meta.hedge ? (
                    <p className="text-[11px] italic leading-relaxed" style={{ color: meta.color }}>
                      {meta.hedge}
                    </p>
                  ) : null}
                  <p className="text-xs leading-relaxed text-neutral-400">{u.note}</p>

                  {hasTrail ? (
                    <div className="space-y-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                        escape trail — where the value went before the trace was lost
                      </div>
                      <ol className="space-y-2">
                        {trail.map((ref, i) => (
                          <li key={i} className="flex gap-2">
                            <span className="select-none pt-1 font-mono text-[10px] text-neutral-600">
                              {i + 1}.
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="font-mono text-[11px] text-neutral-500">
                                <SourceLink source={ref}>
                                  {ref.filePath}:{ref.startLine}
                                  {ref.endLine !== ref.startLine ? `-${ref.endLine}` : ''}
                                </SourceLink>
                              </div>
                              <pre className="mt-1 overflow-x-auto rounded border border-neutral-800 bg-black/60 p-2 font-mono text-[11px] leading-relaxed text-neutral-300">
                                {ref.snippet}
                              </pre>
                            </div>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ) : u.evidence.length > 0 ? (
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
                      No reads found in TypeScript — this rests on the absence of any TS read.
                    </p>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      )}
    </div>
  );
}
