import { useState } from 'react';
import type { Graph, SourceRef } from '@throughline/core';
import { buildRootCauseFixRequest, type RootCauseClass, type RootCauseRow } from '../lib/rootCauses';
import { FixPromptBlock } from './FixPromptBlock';

interface RootCauseCardProps {
  row: RootCauseRow;
  graph: Graph;
  topLever: boolean; // the single biggest actionable lever — surfaced prominently
  onShowAffected: (contracts: string[]) => void;
}

const CLASS_META: Record<
  RootCauseClass,
  { badge: string; color: string; lead: string }
> = {
  resolved: {
    badge: 'Fix here',
    color: 'var(--color-verified)',
    lead: "Type the client where it's constructed — one edit flips every touch below.",
  },
  parameter: {
    badge: 'Fix one step back',
    color: 'var(--color-narrowed)',
    lead: 'Client passed in untyped — type these parameter signatures and the touches below resolve.',
  },
  ref: {
    badge: 'Ref indirection',
    color: 'var(--color-edge-read)',
    lead: 'Reached through a ref/closure indirection — no single signature to type.',
  },
  'imported-untyped': {
    badge: 'Untyped import',
    color: 'var(--color-edge-read)',
    lead: 'An imported singleton that is untyped at its definition.',
  },
  other: {
    badge: 'No single fix site',
    color: 'var(--color-text-muted)',
    lead: 'No single fix site — type as you go. This is not a one-click lever.',
  },
};

const REASON_GUIDANCE: Record<string, { lead: string; fixLabel: string; warning?: string }> = {
  'ts-loose-client': {
    lead: 'The client reaching these calls is loose. Type the construction/signature to let the compiler carry the schema.',
    fixLabel: 'Client origin',
  },
  'ts-cast-concrete': {
    lead: 'These usage sites cast results to a concrete shape. Typing the factory alone will not clear them; remove or replace the casts.',
    fixLabel: 'Shared origin, but casts block progress',
    warning: 'Factory fixes can be correct and still show zero delta until these downstream casts are removed.',
  },
  'ts-cast-any': {
    lead: 'These usage sites erase type evidence with any/unknown/never. Fix the erasure at the usage site.',
    fixLabel: 'Usage-site erasure',
    warning: 'A typed factory cannot override an explicit any/unknown cast downstream.',
  },
  'ts-bypass-any': {
    lead: 'These calls bypass the typed client by casting the table name. Fix the table access at the usage site.',
    fixLabel: 'Usage-site bypass',
    warning: 'The construction may already be typed; the bypass keeps this touch dark.',
  },
};

const REASON_LABEL: Record<string, string> = {
  'ts-loose-client': 'untyped client',
  'ts-cast-concrete': 'unchecked cast',
  'ts-cast-any': 'cast to any / unknown',
  'ts-bypass-any': 'table name cast as any',
};

function loc(s: SourceRef): string {
  return `${s.filePath}:${s.startLine}`;
}

function SourceLine({ s }: { s: SourceRef }) {
  return (
    <div className="rounded border border-neutral-800 bg-black/40 px-2 py-1">
      <div className="font-mono text-[11px] text-neutral-400">{loc(s)}</div>
      <code className="block truncate font-mono text-[11px] text-neutral-300">
        {s.snippet.split('\n')[0]}
      </code>
    </div>
  );
}

export function RootCauseCard({ row, graph, topLever, onShowAffected }: RootCauseCardProps) {
  const [expanded, setExpanded] = useState(false);
  const { rc, klass, actionable, affectedTouches } = row;
  const meta = CLASS_META[klass];
  const guidance = REASON_GUIDANCE[rc.reason];
  const reason = REASON_LABEL[rc.reason] ?? rc.reason;
  const sigCount = rc.evidence?.length ?? 0;
  const blocking = row.blockingTouches.slice(0, 5);

  const title =
    klass === 'resolved'
      ? rc.origin.name
      : klass === 'parameter'
        ? 'client passed in untyped'
        : klass === 'ref'
          ? 'client via ref indirection'
          : klass === 'imported-untyped'
            ? 'untyped imported client'
            : 'no single construction site';

  return (
    <div
      className={`rounded-lg border bg-neutral-900/60 p-4 shadow-elev1 transition ${
        topLever ? 'border-trust-narrowed' : 'border-neutral-800'
      }`}
    >
      <div className="flex items-start gap-4">
        {/* Leverage — the number that makes the ranking obvious. */}
        <div className="flex w-16 shrink-0 flex-col items-center rounded-md bg-black/30 py-2">
          <span className="text-2xl font-semibold leading-none text-neutral-100">{rc.affectedCount}</span>
          <span className="mt-0.5 text-[10px] uppercase tracking-wide text-neutral-500">touches</span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
              style={{ color: meta.color, borderColor: meta.color }}
            >
              {meta.badge}
            </span>
            {topLever ? (
              <span className="rounded-full bg-trust-narrowed/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-trust-narrowed">
                Top lever
              </span>
            ) : null}
            <span className="text-[11px] text-neutral-500">{reason}</span>
          </div>

          <h3 className="mt-1 truncate font-mono text-sm text-neutral-100" title={title}>
            {title}
          </h3>

          <p className="mt-0.5 text-xs text-neutral-400">
            Explains <span className="text-neutral-200">{rc.affectedCount}</span> touch
            {rc.affectedCount === 1 ? '' : 'es'} across{' '}
            <span className="text-neutral-200">{rc.affectedContracts.length}</span> contract
            {rc.affectedContracts.length === 1 ? '' : 's'}.
          </p>

          <p className="mt-1.5 text-xs leading-relaxed text-neutral-400">
            {guidance?.lead ?? meta.lead}
          </p>
          {guidance?.warning ? (
            <p className="mt-1.5 rounded border border-trust-narrowed/40 bg-trust-narrowed/10 px-2 py-1.5 text-[11px] leading-relaxed text-trust-narrowed">
              {guidance.warning}
            </p>
          ) : null}

          {/* The fix site(s): construction site for resolved, signatures for parameter. */}
          {klass === 'resolved' && rc.origin.source ? (
            <div className="mt-2">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                {guidance?.fixLabel ?? 'Construction site'}
              </div>
              <SourceLine s={rc.origin.source} />
            </div>
          ) : null}

          {klass === 'parameter' && sigCount > 0 ? (
            <div className="mt-2">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                {sigCount} signature{sigCount === 1 ? '' : 's'} to type
              </div>
              <div className="space-y-1">
                {rc.evidence!.map((s) => (
                  <SourceLine key={loc(s)} s={s} />
                ))}
              </div>
            </div>
          ) : null}

          {/* Actions */}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {rc.affectedContracts.length > 0 ? (
              <button
                type="button"
                onClick={() => onShowAffected(rc.affectedContracts)}
                className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-200 transition hover:border-neutral-500 hover:text-neutral-50"
              >
                Show {rc.affectedContracts.length} affected contract
                {rc.affectedContracts.length === 1 ? '' : 's'}
              </button>
            ) : null}
            {affectedTouches.length > 0 ? (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="text-xs font-medium text-neutral-400 transition hover:text-neutral-200"
              >
                {expanded ? 'Hide' : 'Show'} affected touches ({affectedTouches.length})
              </button>
            ) : null}
          </div>

          {expanded ? (
            <div className="mt-2 space-y-1">
              {affectedTouches.map((t) => (
                <div
                  key={t.id}
                  className="rounded border border-neutral-800 bg-black/30 px-2 py-1 font-mono text-[11px] text-neutral-400"
                >
                  {t.source ? loc(t.source) : t.id}
                  <span className="ml-2 text-neutral-600">{t.label}</span>
                </div>
              ))}
            </div>
          ) : null}

          {blocking.length > 0 ? (
            <div className="mt-2">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                Blocking usage site{row.blockingTouches.length === 1 ? '' : 's'}
              </div>
              <div className="space-y-1">
                {blocking.map((t) =>
                  t.source ? <SourceLine key={t.id} s={t.source} /> : null,
                )}
              </div>
              {row.blockingTouches.length > blocking.length ? (
                <div className="mt-1 text-[11px] text-neutral-600">
                  +{row.blockingTouches.length - blocking.length} more usage sites
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Actionable root causes get a real fix prompt; non-actionable do NOT. */}
          {actionable ? (
            <FixPromptBlock
              node={buildRootCauseFixRequest(row, graph).node}
              context={buildRootCauseFixRequest(row, graph).context}
              label="Generate fix prompt for this root cause"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
