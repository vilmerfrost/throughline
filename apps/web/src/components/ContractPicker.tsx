import { useMemo, useState } from 'react';
import type { ContractSummary } from '../lib/focus';
import { verdictWeight, worstTrustVar, type Weight } from '../lib/trust';

interface ContractPickerProps {
  summaries: ContractSummary[]; // already sorted worst-trust-first
  selectedId: string | null;
  onSelect: (id: string) => void;
}

// Visual weight for a row: bigger dot + brighter text for the worst verdicts,
// quieter rows for verified/untouched. Colors stay the same — only pixel-weight
// changes — so the user's eye drops onto the problems first.
function pickerWeightStyles(weight: Weight): {
  dotPx: number;
  rowOpacity: number;
  textTone: string;
  subTone: string;
  tint?: string; // optional faint background stripe for critical rows
} {
  switch (weight) {
    case 'critical':
      return {
        dotPx: 14,
        rowOpacity: 1,
        textTone: 'text-neutral-50',
        subTone: 'text-neutral-400',
        tint: 'color-mix(in oklab, var(--color-mismatch) 9%, transparent)',
      };
    case 'attention':
      return {
        dotPx: 12,
        rowOpacity: 1,
        textTone: 'text-neutral-100',
        subTone: 'text-neutral-500',
      };
    case 'okay':
      return {
        dotPx: 10,
        rowOpacity: 0.92,
        textTone: 'text-neutral-200',
        subTone: 'text-neutral-500',
      };
    case 'quiet':
      return {
        dotPx: 8,
        rowOpacity: 0.7,
        textTone: 'text-neutral-300',
        subTone: 'text-neutral-600',
      };
  }
}

// Left rail: every contract, dot + order both driven by the WORST trust among
// its touches (green only when every touch is verified; gray when untouched).
// Searchable by table name. Selecting a row drives the focus flow. Rows with
// the worst verdicts get more pixel-weight so the problems pop against the
// gray (presentation only — verdict semantics are unchanged).
export function ContractPicker({ summaries, selectedId, onSelect }: ContractPickerProps) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? summaries.filter((s) => s.label.toLowerCase().includes(q)) : summaries;
  }, [summaries, query]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-neutral-800 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
            Contracts
          </span>
          <span className="text-[11px] text-neutral-600">{summaries.length}</span>
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tables…"
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-neutral-600">No tables match.</div>
        ) : (
          <ul>
            {filtered.map((s) => {
              const active = s.id === selectedId;
              const w = pickerWeightStyles(verdictWeight(s.verdict));
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(s.id)}
                    className={`flex w-full items-start gap-2.5 border-l-2 px-3 py-2 text-left transition ${
                      active
                        ? 'border-trust-contract bg-neutral-900'
                        : 'border-transparent hover:bg-neutral-900/60'
                    }`}
                    style={{
                      opacity: active ? 1 : w.rowOpacity,
                      backgroundImage:
                        !active && w.tint ? `linear-gradient(${w.tint}, ${w.tint})` : undefined,
                    }}
                  >
                    <span
                      className="mt-1 shrink-0 rounded-full"
                      style={{
                        background: worstTrustVar(s.verdict),
                        width: w.dotPx,
                        height: w.dotPx,
                      }}
                      title={s.verdict ?? 'untouched'}
                    />
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate font-mono text-sm ${w.textTone}`}>
                        {s.label}
                      </span>
                      <span className={`block text-[11px] ${w.subTone}`}>
                        {s.writeCount} writes · {s.readCount} reads
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
