import type { ReactNode } from 'react';
import type { ColumnReach } from '@throughline/core';
import { toneVar, verdictMeta, type Verdict } from '../lib/trust';
import { REACH_META } from '../lib/columnUsage';
import {
  FILTER_REACHES,
  FILTER_VERDICTS,
  REACH_FILTER_LABEL,
  isFocusFilterActive,
  type FocusFilterState,
} from '../lib/focusFilter';

interface FocusFilterBarProps {
  filter: FocusFilterState;
  shown: number;
  total: number;
  onToggleVerdict: (v: Verdict) => void;
  onToggleReach: (r: ColumnReach) => void;
  onClear: () => void;
}

// Chip with a leading status dot. Active chips brighten; inactive ones stay
// muted but keep their color dot so the scale is always readable.
function Chip({
  active,
  color,
  onClick,
  title,
  children,
}: {
  active: boolean;
  color: string;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide transition ${
        active
          ? 'border-neutral-600 bg-neutral-800 text-neutral-100'
          : 'border-neutral-800 text-neutral-500 hover:text-neutral-300'
      }`}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      {children}
    </button>
  );
}

// Triage filter above the contract list. Two chip groups (worst verdict +
// columns present), multi-select with OR semantics, a live count, and clear-all.
export function FocusFilterBar({
  filter,
  shown,
  total,
  onToggleVerdict,
  onToggleReach,
  onClear,
}: FocusFilterBarProps) {
  const active = isFocusFilterActive(filter);
  const scoped = filter.contracts.size > 0;

  return (
    <div className="space-y-2 border-b border-neutral-800 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
          Filter
        </span>
        <span className="text-[11px] text-neutral-500">
          {active ? (
            <>
              <span className="text-neutral-300">{shown}</span> of {total} contracts
            </>
          ) : (
            <span className="text-neutral-600">{total} contracts</span>
          )}
        </span>
      </div>

      {scoped ? (
        // Root-cause scope is a focused lens — show it distinctly from the chips
        // and let it be cleared in one click. Chips are hidden while scoped.
        <div
          className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5"
          style={{ borderColor: 'var(--color-ai)' }}
        >
          <span className="text-[11px] leading-tight text-neutral-300">
            Scoped to{' '}
            <span className="font-semibold" style={{ color: 'var(--color-ai)' }}>
              {filter.contracts.size}
            </span>{' '}
            contract{filter.contracts.size === 1 ? '' : 's'} from a root cause
          </span>
          <button
            type="button"
            onClick={onClear}
            className="shrink-0 text-[11px] font-medium text-neutral-400 transition hover:text-neutral-200"
          >
            Clear ✕
          </button>
        </div>
      ) : null}

      <div className={`flex flex-wrap gap-1 ${scoped ? 'pointer-events-none opacity-40' : ''}`}>
        {FILTER_VERDICTS.map((v) => (
          <Chip
            key={v}
            active={filter.verdicts.has(v)}
            color={toneVar(v)}
            onClick={() => onToggleVerdict(v)}
            title={verdictMeta(v).blurb}
          >
            {v}
          </Chip>
        ))}
      </div>

      <div className={`flex flex-wrap gap-1 ${scoped ? 'pointer-events-none opacity-40' : ''}`}>
        {FILTER_REACHES.map((r) => (
          <Chip
            key={r}
            active={filter.reaches.has(r)}
            color={REACH_META[r].color}
            onClick={() => onToggleReach(r)}
            title={REACH_META[r].blurb}
          >
            {REACH_FILTER_LABEL[r]}
          </Chip>
        ))}
      </div>

      {active && !scoped ? (
        <button
          type="button"
          onClick={onClear}
          className="text-[11px] font-medium text-neutral-400 transition hover:text-neutral-200"
        >
          Clear all
        </button>
      ) : null}
    </div>
  );
}
