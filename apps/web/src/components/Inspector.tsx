import type { ColumnReach, DriftFinding, Graph, GraphNode } from '@throughline/core';
import { buildAggregateExplainRequest, buildExplainContext } from '../lib/api';
import { effectiveVerdict, langTag, severityVar, toneOf, toneVar, verdictMeta } from '../lib/trust';
import { ColumnUsageList } from './ColumnUsageList';
import { ExplainPanel } from './ExplainPanel';
import { SourceLink } from './SourceLink';
import { TouchExplainCard } from './TouchExplainCard';

// When an aggregate lane node is selected, the inspector lists the individual
// touches it rolls up (each with its own Explain button) instead of one node.
export interface AggregateSelection {
  title: string;
  touches: GraphNode[];
}

interface InspectorProps {
  node: GraphNode | null;
  graph: Graph | null;
  drift: DriftFinding[];
  aggregate?: AggregateSelection | null;
  // Focus-view within-contract reach filter, applied to the column list.
  reachFilter?: Set<ColumnReach>;
}

// §5C — the anchor of truth for a node. Reflects state from the selected node;
// holds no independent copy of node properties.
export function Inspector({ node, graph, drift, aggregate, reachFilter }: InspectorProps) {
  // Aggregate mode takes precedence: list the real individual touches behind a
  // lane node. These are reads/writes Throughline detected — not UI renders.
  if (aggregate) {
    const aggregateExplain = graph
      ? buildAggregateExplainRequest(aggregate.title, aggregate.touches, graph)
      : null;

    return (
      <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
            touches
          </div>
          <h2 className="mt-1 break-words font-mono text-lg text-neutral-100">{aggregate.title}</h2>
          <p className="mt-1 text-xs text-neutral-500">
            {aggregate.touches.length} individual{' '}
            {aggregate.touches.length === 1 ? 'touch' : 'touches'} — reads/writes Throughline
            detected, not UI renders.
          </p>
        </div>
        <ul className="space-y-2">
          {aggregate.touches.map((t) => (
            <TouchExplainCard key={t.id} node={t} />
          ))}
        </ul>
        {aggregateExplain ? (
          <ExplainPanel node={aggregateExplain.node} context={aggregateExplain.context} />
        ) : null}
      </div>
    );
  }

  if (!node) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-neutral-500">
        Select a node to inspect its source, trust level, and any drift it is involved in.
      </div>
    );
  }

  const verdict = effectiveVerdict(node);
  const tone = toneOf(node.kind, verdict);
  const color = toneVar(tone);
  const relatedDrift = drift.filter((d) => d.contractId === node.id);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      {/* Header block */}
      <div>
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full" style={{ background: color }} />
          <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
            {node.kind}
          </span>
          {node.language ? (
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-neutral-300">
              {langTag(node.language)}
            </span>
          ) : null}
        </div>
        <h2 className="mt-1 break-words font-mono text-lg text-neutral-100">{node.label}</h2>
      </div>

      {/* Verdict banner — schemaMatch (aligned/mismatch) overrides trust when set. */}
      {verdict ? (
        <div className="rounded-md border px-3 py-2 text-sm" style={{ borderColor: color, color }}>
          <span className="font-semibold">{verdictMeta(verdict).label}</span>
          <span className="ml-2 text-neutral-400">{verdictMeta(verdict).blurb}</span>
        </div>
      ) : null}

      {node.notes ? (
        <p className="text-sm leading-relaxed text-neutral-300">{node.notes}</p>
      ) : null}

      {/* Columns — contracts only. With per-column read-usage verdicts when the
          analyzer provided them; otherwise the plain schema table. */}
      {node.columns && node.columnUsage && node.columnUsage.length > 0 ? (
        <ColumnUsageList columns={node.columns} usage={node.columnUsage} reachFilter={reachFilter} />
      ) : node.columns ? (
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
            Columns
          </div>
          <table className="w-full text-sm">
            <tbody>
              {node.columns.map((c) => (
                <tr key={c.name} className="border-b border-neutral-800 last:border-0">
                  <td className="py-1 font-mono text-neutral-200">{c.name}</td>
                  <td className="py-1 font-mono text-neutral-400">{c.type}</td>
                  <td className="py-1 text-right font-mono text-[11px] text-neutral-500">
                    {c.nullable ? 'nullable' : 'not null'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* Source block — the grounded source of truth */}
      {node.source ? (
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
            Source
          </div>
          <div className="font-mono text-xs text-neutral-400">
            <SourceLink source={node.source}>
              {node.source.filePath}:{node.source.startLine}
              {node.source.endLine !== node.source.startLine ? `-${node.source.endLine}` : ''}
            </SourceLink>
          </div>
          <pre className="mt-2 overflow-x-auto rounded-md border border-neutral-800 bg-black/60 p-3 font-mono text-xs leading-relaxed text-neutral-200">
            {node.source.snippet}
          </pre>
        </div>
      ) : null}

      {/* Drift list — colored by severity */}
      {relatedDrift.length > 0 ? (
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
            Drift
          </div>
          <ul className="space-y-2">
            {relatedDrift.map((d, i) => (
              <li
                key={i}
                className="rounded-md border px-3 py-2 text-sm"
                style={{ borderColor: severityVar(d.severity) }}
              >
                <span
                  className="text-[11px] font-semibold uppercase"
                  style={{ color: severityVar(d.severity) }}
                >
                  {d.severity}
                </span>
                <p className="mt-1 text-neutral-200">{d.message}</p>
                <div className="mt-1 font-mono text-[11px] text-neutral-500">
                  {d.source.filePath}:{d.source.startLine}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* AI commentary — visually distinct from the grounded facts above. */}
      {graph ? <ExplainPanel node={node} context={buildExplainContext(node, graph)} /> : null}
    </div>
  );
}
