import { useEffect, useState } from 'react';
import type { Trust } from '@throughline/core';
import { SCHEMA_MATCH_COPY, SCHEMA_MATCH_META, TRUST_COPY, TRUST_META, toneDotClass } from '../lib/trust';
import { REACH_META, REACH_ORDER, reachDot } from '../lib/columnUsage';

// Ordered best -> worst so the scale reads "type-checked -> no checked type".
const TRUST_ORDER: Trust[] = ['verified', 'narrowed', 'asserted', 'dark'];

// Schema-match tiers (deep-parsed writes): the good-but-not-enforced verdict and
// the alarming one. Listed alongside trust so the aligned-vs-verified honesty
// distinction reads at a glance.
const SCHEMA_MATCH_ORDER = ['aligned', 'mismatch'] as const;

// Persisted "I've seen the legend at least once" flag — first ever load gets the
// legend open; subsequent loads default closed (but still respect any explicit
// toggle the user made). The two keys are deliberately separate so the seen
// flag isn't perturbed by manual toggling.
const SEEN_KEY = 'throughline:legend:seen';
const OPEN_KEY = 'throughline:legend:open';

function readInitialOpen(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const stored = window.localStorage.getItem(OPEN_KEY);
    if (stored !== null) return stored === 'true';
    // No explicit state: first ever view = open; mark seen so next time we
    // default to collapsed without overriding any future explicit toggle.
    const seen = window.localStorage.getItem(SEEN_KEY) === 'true';
    if (!seen) {
      window.localStorage.setItem(SEEN_KEY, 'true');
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Collapsible legend for the focus view. Default state: open on first ever load
// (so users learn the axes), collapsed thereafter. The toggle preference is
// persisted, so it survives reloads. Keeps the same content as before — never
// deletes it — just stops it occupying permanent vertical space.
export function FocusLegend() {
  const [open, setOpen] = useState<boolean>(() => readInitialOpen());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(OPEN_KEY, String(open));
    } catch {
      // Ignore — non-fatal; legend will just default-collapse next load.
    }
  }, [open]);

  return (
    <div className="shrink-0 border-t border-neutral-800 bg-neutral-900">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-[11px] text-neutral-400 transition hover:bg-neutral-800/40"
        aria-expanded={open}
        aria-controls="focus-legend-body"
      >
        <span className="flex items-center gap-2 font-semibold uppercase tracking-wide text-neutral-500">
          <span
            className="inline-block text-neutral-600 transition-transform"
            style={{ transform: open ? 'rotate(90deg)' : 'none' }}
            aria-hidden
          >
            ›
          </span>
          What do these mean?
        </span>
        {/* Mini swatch row so the legend hints at its content even when closed.
            Kept silent (no labels) so it doesn't compete with the canvas. */}
        {!open ? (
          <span className="flex items-center gap-1.5 text-neutral-600" aria-hidden>
            {TRUST_ORDER.map((t) => (
              <span key={t} className={`h-2 w-2 rounded-full ${toneDotClass(t)}`} />
            ))}
            <span className="mx-1 h-3 w-px bg-neutral-700" />
            {SCHEMA_MATCH_ORDER.map((s) => (
              <span key={s} className={`h-2 w-2 rounded-full ${toneDotClass(s)}`} />
            ))}
            <span className="mx-1 h-3 w-px bg-neutral-700" />
            {REACH_ORDER.map((r) => (
              <span key={r} className="h-2 w-2 rounded-full" style={reachDot(r, true)} />
            ))}
          </span>
        ) : (
          <span className="text-neutral-600">Hide</span>
        )}
      </button>

      {open ? (
        <div
          id="focus-legend-body"
          className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-neutral-800 px-4 py-2 text-[11px] text-neutral-400"
        >
          {/* Kind axis — contract, shown as its double-border TABLE shape. */}
          <span className="font-semibold uppercase tracking-wide text-neutral-600">
            contract = a kind
          </span>
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

          {/* Schema-match axis — deep-parsed writes. aligned is teal, NOT verified
              green: matched now, but not compiler-enforced. */}
          <span className="font-semibold uppercase tracking-wide text-neutral-600">
            schema match = a scale (writes)
          </span>
          {SCHEMA_MATCH_ORDER.map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${toneDotClass(s)}`} />
              <span className="text-neutral-200">{SCHEMA_MATCH_COPY[s].plain}</span>
              <span className="text-neutral-500">{s}</span>
              <span className="text-neutral-500">— {SCHEMA_MATCH_META[s].blurb}</span>
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

          {/* Column read-REACH axis — where each column's value travels. Filled dot =
              a certain read; hollow = a heuristic (or untraceable) inference. The
              no-reader and untraceable states carry an honest hedge in their copy. */}
          <span className="mx-1 h-3.5 w-px bg-neutral-700" />
          <span className="font-semibold uppercase tracking-wide text-neutral-600">
            column reach = where the value goes
          </span>
          <span className="text-neutral-600">(filled = certain · hollow = heuristic)</span>
          {REACH_ORDER.map((r) => {
            const meta = REACH_META[r];
            return (
              <span key={r} className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={reachDot(r, true)} />
                <span style={{ color: meta.color }}>{meta.label}</span>
                <span className="text-neutral-500">— {meta.blurb}</span>
              </span>
            );
          })}

          {/* Count badge — every lane node folds together all touches that share
              one (language × direction × verdict); the ×N badge is that count. */}
          <span className="mx-1 h-3.5 w-px bg-neutral-700" />
          <span className="font-semibold uppercase tracking-wide text-neutral-600">
            ×N = aggregated touches
          </span>
          <span className="flex items-center gap-1.5">
            <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] font-semibold text-neutral-200">
              ×N
            </span>
            <span className="text-neutral-500">
              — N code locations of the same language, direction &amp; verdict. Click a card to expand them.
            </span>
          </span>
        </div>
      ) : null}
    </div>
  );
}
