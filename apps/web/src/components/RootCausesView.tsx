import { useMemo } from 'react';
import type { Graph, RootCause } from '@throughline/core';
import { buildRootCauseRows } from '../lib/rootCauses';
import { RootCauseCard } from './RootCauseCard';

interface RootCausesViewProps {
  graph: Graph;
  previousGraph?: Graph | null;
  onShowAffected: (contracts: string[]) => void;
}

// Cross-cutting triage companion to the per-contract filter: the deterministic
// root-cause rollup, ranked biggest-lever-first. The big shared-client levers
// are already typed; this is the honest "what's left", grouped by where the fix
// actually lives (a construction site, a set of signatures, or nowhere single).
export function RootCausesView({ graph, previousGraph, onShowAffected }: RootCausesViewProps) {
  const rows = useMemo(() => buildRootCauseRows(graph), [graph]);

  const stats = useMemo(() => {
    const total = rows.reduce((n, r) => n + r.rc.affectedCount, 0);
    const actionable = rows.filter((r) => r.actionable).reduce((n, r) => n + r.rc.affectedCount, 0);
    const noFixSite = rows
      .filter((r) => r.klass === 'other')
      .reduce((n, r) => n + r.rc.affectedCount, 0);
    return { total, actionable, noFixSite };
  }, [rows]);

  const delta = useMemo(() => previousGraph ? rootCauseDelta(previousGraph.rootCauses ?? [], graph.rootCauses ?? []) : null, [previousGraph, graph]);

  // The single biggest actionable lever (rows are already ranked) gets a ribbon.
  const topLeverKey = rows.find((r) => r.actionable)?.key ?? null;

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-neutral-950">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <header className="mb-5">
          <h2 className="text-lg font-semibold tracking-tight text-neutral-100">Root causes</h2>
          <p className="mt-1 text-sm leading-relaxed text-neutral-400">
            Every dark/asserted TypeScript touch, grouped by the one thing that would flip it —
            ranked by how many touches each fix clears. The big shared clients are already typed;
            this is what's left.
          </p>

          {rows.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-4 text-xs text-neutral-400">
              {delta ? (
                <span>
                  <span className={delta.clearedTouches > 0 ? 'text-trust-verified' : 'text-neutral-500'}>
                    {delta.clearedTouches}
                  </span>{' '}
                  touches cleared since last refresh
                </span>
              ) : null}
              <span>
                <span className="text-neutral-200">{stats.total}</span> touches explained
              </span>
              <span>
                <span className="text-trust-verified">{stats.actionable}</span> behind a single fix
              </span>
              <span>
                <span className="text-neutral-500">{stats.noFixSite}</span> with no single fix site
              </span>
              {delta ? (
                <span>
                  <span className="text-neutral-200">{delta.removedCauses}</span> root causes removed
                </span>
              ) : null}
            </div>
          ) : null}
        </header>

        {rows.length === 0 ? (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-8 text-center text-sm text-neutral-500">
            No root causes — every TypeScript touch is already verified or narrowed.
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map((row) => (
              <RootCauseCard
                key={row.key}
                row={row}
                graph={graph}
                topLever={row.key === topLeverKey}
                onShowAffected={onShowAffected}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function rootCauseDelta(previous: RootCause[], current: RootCause[]) {
  const currentByKey = new Map(current.map((rc) => [rootCauseKey(rc), rc]));
  const removed = previous.filter((rc) => !currentByKey.has(rootCauseKey(rc)));
  const reducedTouches = previous.reduce((sum, prev) => {
    const now = currentByKey.get(rootCauseKey(prev));
    if (!now) return sum;
    return sum + Math.max(0, prev.affectedCount - now.affectedCount);
  }, 0);
  return {
    removedCauses: removed.length,
    clearedTouches: removed.reduce((sum, rc) => sum + rc.affectedCount, 0) + reducedTouches,
  };
}

function rootCauseKey(rc: RootCause): string {
  const loc = rc.origin.source
    ? `${rc.origin.source.filePath}:${rc.origin.source.startLine}`
    : (rc.origin.shape ?? 'other');
  return `${rc.reason}::${rc.origin.name}::${loc}`;
}
