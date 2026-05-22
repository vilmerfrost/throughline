import type { Trust } from '@throughline/core';
import { SCHEMA_MATCH_META, TRUST_META, toneDotClass } from '../lib/trust';

const TRUST_ORDER: Trust[] = ['verified', 'narrowed', 'asserted', 'dark'];
const SCHEMA_MATCH_ORDER = ['aligned', 'mismatch'] as const;

// Explains the spine color + trust colors + schema-match colors — at a glance.
export function Legend() {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/90 p-3 text-xs backdrop-blur">
      <div className="mb-2 font-semibold text-neutral-300">Trust legend</div>
      <ul className="space-y-1.5">
        <li className="flex items-center gap-2">
          <span className={`h-3 w-3 rounded-full ${toneDotClass('contract')}`} />
          <span className="text-neutral-400">
            <span className="text-neutral-200">contract</span> — the data spine (SQL)
          </span>
        </li>
        {TRUST_ORDER.map((t) => (
          <li key={t} className="flex items-center gap-2">
            <span className={`h-3 w-3 rounded-full ${toneDotClass(t)}`} />
            <span className="text-neutral-400">
              <span className="text-neutral-200">{TRUST_META[t].label}</span> — {TRUST_META[t].blurb}
            </span>
          </li>
        ))}
        {/* Schema-match (deep-parsed writes) — aligned is teal, NOT verified green. */}
        {SCHEMA_MATCH_ORDER.map((s) => (
          <li key={s} className="flex items-center gap-2">
            <span className={`h-3 w-3 rounded-full ${toneDotClass(s)}`} />
            <span className="text-neutral-400">
              <span className="text-neutral-200">{SCHEMA_MATCH_META[s].label}</span> — {SCHEMA_MATCH_META[s].blurb}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
