import type { Trust } from '@throughline/core';
import { TRUST_COPY, TRUST_META, toneDotClass } from '../lib/trust';
import { VERDICT_META, VERDICT_ORDER } from '../lib/columnUsage';

// Ordered best -> worst so the scale reads "type-checked -> no checked type".
const TRUST_ORDER: Trust[] = ['verified', 'narrowed', 'asserted', 'dark'];

// Persistent (never dismissible) legend for the focus view. Teaches the two
// distinct axes: contract is a KIND (drawn as its table shape), trust is a
// SCALE (plain phrase primary, jargon word secondary, one-line meaning each).
export function FocusLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-neutral-800 bg-neutral-900 px-4 py-2 text-[11px] text-neutral-400">
      {/* Kind axis — contract, shown as its double-border TABLE shape. */}
      <span className="font-semibold uppercase tracking-wide text-neutral-600">contract = a kind</span>
      <span className="flex items-center gap-1.5">
        <span className="inline-flex h-3.5 w-6 shrink-0 rounded-[3px] border-2 border-trust-contract p-[1.5px]">
          <span className="h-full w-full rounded-[1px] border border-trust-contract" />
        </span>
        <span className="text-neutral-200">the table</span> — source of truth
      </span>

      <span className="mx-1 h-3.5 w-px bg-neutral-700" />

      {/* Trust axis — a scale from type-checked to no checked type. */}
      <span className="font-semibold uppercase tracking-wide text-neutral-600">
        trust = a scale
      </span>
      {TRUST_ORDER.map((t) => (
        <span key={t} className="flex items-center gap-1.5">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${toneDotClass(t)}`} />
          <span className="text-neutral-200">{TRUST_COPY[t].plain}</span>
          <span className="text-neutral-500">{t}</span>
          <span className="text-neutral-500">— {TRUST_META[t].blurb}</span>
        </span>
      ))}

      <span className="mx-1 h-3.5 w-px bg-neutral-700" />

      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-5" style={{ background: 'var(--color-edge-write)' }} />
        <span className="text-neutral-200">write</span> — data enters
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-5" style={{ background: 'var(--color-edge-read)' }} />
        <span className="text-neutral-200">read</span> — data exits
      </span>

      {/* Column read-usage axis — how each column is read. Filled dot = the only
          certain verdict; hollow = a heuristic (or untraceable) inference. */}
      <span className="mx-1 h-3.5 w-px bg-neutral-700" />
      <span className="font-semibold uppercase tracking-wide text-neutral-600">
        column reads = a scale
      </span>
      <span className="text-neutral-600">(filled = certain · hollow = heuristic)</span>
      {VERDICT_ORDER.map((v) => {
        const meta = VERDICT_META[v];
        return (
          <span key={v} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={meta.dot} />
            <span className="text-neutral-200">{meta.label}</span>
            <span className="text-neutral-500">— {meta.blurb}</span>
          </span>
        );
      })}
    </div>
  );
}
