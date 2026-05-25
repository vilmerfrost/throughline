import { useMemo, useState, type CSSProperties } from 'react';
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

interface Row {
  col: ContractColumn;
  usage: ColumnUsage | undefined;
  reach: ColumnReach;
  certain: boolean;
  order: number;
}

// A column with no usage data falls back to the heuristic ring (matches `reachOf`).
function rowCertain(u: ColumnUsage | undefined): boolean {
  return u?.certain ?? false;
}

// Collapse rule — picked to match the "16 identical rows" pain point. The
// trigger is the ABSOLUTE size of the dominant reach group, not a percentage:
// even a 13-of-22 majority is still 13 duplicate rows worth rolling up. Small
// contracts (3 or fewer of a kind) are left as-is — collapsing them would cost
// a click for no real density saving.
const MIN_GROUP_SIZE = 5;
const MIN_ALL_SIZE = 4; // 'all' mode is more aggressive — every row is the same

type CollapseMode = 'normal' | 'all' | 'dominant';

interface CollapseDecision {
  mode: CollapseMode;
  collapsedReach: ColumnReach | null;
  groupRows: Row[]; // the rows in the collapsed group (empty if mode='normal')
  groupCertainUniform: boolean | null; // null = mixed (don't surface markers)
}

function decideCollapse(rows: Row[]): CollapseDecision {
  if (rows.length < MIN_ALL_SIZE) {
    return { mode: 'normal', collapsedReach: null, groupRows: [], groupCertainUniform: null };
  }
  const byReach = new Map<ColumnReach, Row[]>();
  for (const r of rows) {
    const arr = byReach.get(r.reach) ?? [];
    arr.push(r);
    byReach.set(r.reach, arr);
  }
  const [topReach, topRows] =
    [...byReach.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? [null, []];
  if (!topReach) {
    return { mode: 'normal', collapsedReach: null, groupRows: [], groupCertainUniform: null };
  }
  const topCount = topRows.length;
  const certainUniform =
    topRows.every((r) => r.certain) ? true : topRows.every((r) => !r.certain) ? false : null;

  if (topCount === rows.length && topCount >= MIN_ALL_SIZE) {
    return {
      mode: 'all',
      collapsedReach: topReach,
      groupRows: topRows,
      groupCertainUniform: certainUniform,
    };
  }
  if (topCount >= MIN_GROUP_SIZE) {
    return {
      mode: 'dominant',
      collapsedReach: topReach,
      groupRows: topRows,
      groupCertainUniform: certainUniform,
    };
  }
  return { mode: 'normal', collapsedReach: null, groupRows: [], groupCertainUniform: null };
}

// The contract's columns, annotated with how each one's value actually travels —
// the reach axis. Reach is the ONE status: shown in UI, used server-side but not
// shown, no reader found, or untraceable. The filled/hollow dot keeps the same
// confidence grammar as trust (solid = certain fact, hollow = heuristic). The
// stored-but-not-shown columns (no-reader, then server-only) float to the top so
// the signal is visible at a glance. Click a column for the grounding — the
// reads behind the verdict, or, for an untraceable column, the escape-trail.
//
// Degenerate-state collapse: when one reach verdict dominates (≥ 75%), the
// majority is rolled up into a single summary row labeled "All N columns · …"
// or "N more · …" with an expand affordance — so a 16/16 untraceable contract
// reads as one signal, not 16 identical rows.
export function ColumnUsageList({ columns, usage, reachFilter }: ColumnUsageListProps) {
  const [expandedColumn, setExpandedColumn] = useState<string | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);

  const usageByName = useMemo(() => new Map(usage.map((u) => [u.column, u])), [usage]);
  const filtering = reachFilter && reachFilter.size > 0;

  const rows = useMemo<Row[]>(() => {
    return columns
      .map<Row>((col, order) => {
        const u = usageByName.get(col.name);
        return { col, usage: u, reach: reachOf(u), certain: rowCertain(u), order };
      })
      .filter((r) => !filtering || reachFilter!.has(r.reach))
      .sort((a, b) => {
        const ra = reachRank(a.reach);
        const rb = reachRank(b.reach);
        return ra !== rb ? ra - rb : a.order - b.order;
      });
  }, [columns, usageByName, filtering, reachFilter]);

  const decision = useMemo(() => decideCollapse(rows), [rows]);
  const segments = useMemo(() => reachSummarySegments(summarizeReach(usage)), [usage]);

  // When mode='dominant', outliers render as individual rows. The collapsed
  // group is inserted at the position of its first member so it lands in the
  // right place along the reach-rank sort.
  const renderable = useMemo<
    Array<{ kind: 'row'; row: Row } | { kind: 'group' }>
  >(() => {
    if (decision.mode === 'normal') {
      return rows.map((row) => ({ kind: 'row' as const, row }));
    }
    if (decision.mode === 'all') {
      return [{ kind: 'group' as const }];
    }
    const groupReach = decision.collapsedReach;
    const items: Array<{ kind: 'row'; row: Row } | { kind: 'group' }> = [];
    let inserted = false;
    for (const r of rows) {
      if (r.reach === groupReach) {
        if (!inserted) {
          items.push({ kind: 'group' as const });
          inserted = true;
        }
        continue;
      }
      items.push({ kind: 'row' as const, row: r });
    }
    if (!inserted) items.push({ kind: 'group' as const });
    return items;
  }, [decision, rows]);

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
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
      <p className="mb-2 text-[11px] leading-snug text-neutral-500">
        Scope: scanned TypeScript UI plus migration-defined SQL views. Python, Rust, raw SQL, and external agents remain outside column-level reach.
      </p>

      {filtering && rows.length === 0 ? (
        <div className="rounded-md border border-neutral-800 px-2.5 py-3 text-center text-[11px] text-neutral-600">
          No columns match the reach filter.
        </div>
      ) : (
        <ul className="overflow-hidden rounded-md border border-neutral-800">
          {renderable.map((item, i) => {
            if (item.kind === 'group') {
              return (
                <CollapsedGroupRow
                  key={`group-${i}`}
                  open={groupOpen}
                  onToggle={() => setGroupOpen((v) => !v)}
                  mode={decision.mode === 'all' ? 'all' : 'more'}
                  reach={decision.collapsedReach!}
                  rows={decision.groupRows}
                  certainUniform={decision.groupCertainUniform}
                  expandedColumn={expandedColumn}
                  setExpandedColumn={setExpandedColumn}
                />
              );
            }
            const { row } = item;
            return (
              <ColumnRow
                key={row.col.name}
                row={row}
                open={expandedColumn === row.col.name}
                onToggle={() =>
                  setExpandedColumn(expandedColumn === row.col.name ? null : row.col.name)
                }
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface CollapsedGroupRowProps {
  open: boolean;
  onToggle: () => void;
  mode: 'all' | 'more';
  reach: ColumnReach;
  rows: Row[];
  certainUniform: boolean | null;
  expandedColumn: string | null;
  setExpandedColumn: (name: string | null) => void;
}

// One summary row that stands in for N identical rows of the same reach. When
// opened it reveals each underlying column (still individually expandable).
function CollapsedGroupRow({
  open,
  onToggle,
  mode,
  reach,
  rows,
  certainUniform,
  expandedColumn,
  setExpandedColumn,
}: CollapsedGroupRowProps) {
  const meta = REACH_META[reach];
  const hedge = meta.hedge ?? meta.blurb;
  const count = rows.length;
  const headlineLeft = mode === 'all' ? `All ${count} columns` : `${count} more`;
  const markerWord =
    certainUniform === null ? null : certainUniform ? 'all certain' : 'all heuristic';

  return (
    <>
      <li className="border-b border-neutral-800 last:border-0">
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full items-start gap-2 px-2.5 py-2 text-left transition hover:bg-neutral-800/40"
          style={rowTint(reach)}
          aria-expanded={open}
        >
          {/* Stacked-dot motif marks this as a roll-up, not a single column.
              Certainty matches whatever the group shares (filled vs hollow). */}
          <span
            className="relative mt-1 inline-flex h-3 w-3 shrink-0 items-center justify-center"
            aria-hidden
          >
            <span
              className="absolute h-2 w-2 rounded-full opacity-40"
              style={reachDot(reach, certainUniform === true)}
            />
            <span
              className="relative h-2 w-2 rounded-full"
              style={{
                ...reachDot(reach, certainUniform === true),
                transform: 'translate(2px, 2px)',
              }}
            />
          </span>

          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="font-mono text-sm text-neutral-100">{headlineLeft}</span>
              <span className="font-mono text-[12px]" style={{ color: meta.color }}>
                {meta.label}
              </span>
              {markerWord ? (
                <span className="font-mono text-[10px] text-neutral-600">· {markerWord}</span>
              ) : null}
            </span>
            <span className="mt-0.5 block text-[11px] leading-snug text-neutral-400">{hedge}</span>
          </span>

          <span
            className="ml-2 shrink-0 self-center rounded border border-neutral-700 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-neutral-300"
          >
            {open ? 'Hide' : 'Show all'}
          </span>
          <span
            className="shrink-0 self-center text-neutral-600 transition-transform"
            style={{ transform: open ? 'rotate(90deg)' : 'none' }}
          >
            ›
          </span>
        </button>
      </li>

      {open
        ? rows.map((row) => (
            <ColumnRow
              key={row.col.name}
              row={row}
              open={expandedColumn === row.col.name}
              onToggle={() =>
                setExpandedColumn(expandedColumn === row.col.name ? null : row.col.name)
              }
              nested
            />
          ))
        : null}
    </>
  );
}

interface ColumnRowProps {
  row: Row;
  open: boolean;
  onToggle: () => void;
  // When rendered as a child of a collapsed group, indent slightly so the
  // hierarchy reads at a glance.
  nested?: boolean;
}

function ColumnRow({ row, open, onToggle, nested }: ColumnRowProps) {
  const { col, usage: u, reach } = row;
  const meta = REACH_META[reach];
  const canOpen = !!u;
  const trail = u?.escapeTrail ?? [];
  const hasTrail = reach === 'unknown' && trail.length > 0;

  return (
    <li className="border-b border-neutral-800 last:border-0">
      <button
        type="button"
        disabled={!canOpen}
        onClick={onToggle}
        className={`flex w-full items-center gap-2 py-1.5 text-left transition hover:bg-neutral-800/40 disabled:cursor-default ${
          nested ? 'pl-6 pr-2.5' : 'px-2.5'
        }`}
        style={rowTint(reach)}
        aria-expanded={open}
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
            style={{ transform: open ? 'rotate(90deg)' : 'none' }}
          >
            ›
          </span>
        ) : null}
      </button>

      {open && u ? (
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
                opaque evidence — where the trace became incomplete
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
}
