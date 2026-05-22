import { useMemo } from 'react';
import type { Graph } from '@throughline/core';
import { buildRootCauseRows } from '../lib/rootCauses';
import { RootCauseCard } from './RootCauseCard';

interface RootCausesViewProps {
  graph: Graph;
  onShowAffected: (contracts: string[]) => void;
}

// Cross-cutting triage companion to the per-contract filter: the deterministic
// root-cause rollup, ranked biggest-lever-first. The big shared-client levers
// are already typed; this is the honest "what's left", grouped by where the fix
// actually lives (a construction site, a set of signatures, or nowhere single).
export function RootCausesView({ graph, onShowAffected }: RootCausesViewProps) {
  const rows = useMemo(() => buildRootCauseRows(graph), [graph]);

  const stats = useMemo(() => {
    const total = rows.reduce((n, r) => n + r.rc.affectedCount, 0);
    const actionable = rows.filter((r) => r.actionable).reduce((n, r) => n + r.rc.affectedCount, 0);
    const noFixSite = rows
      .filter((r) => r.klass === 'other')
      .reduce((n, r) => n + r.rc.affectedCount, 0);
    return { total, actionable, noFixSite };
  }, [rows]);

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
              <span>
                <span className="text-neutral-200">{stats.total}</span> touches explained
              </span>
              <span>
                <span className="text-trust-verified">{stats.actionable}</span> behind a single fix
              </span>
              <span>
                <span className="text-neutral-500">{stats.noFixSite}</span> with no single fix site
              </span>
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
