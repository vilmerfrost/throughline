import type { CSSProperties, ReactNode } from 'react';
import type { ColumnReach, DriftFinding, Graph, GraphNode } from '@throughline/core';
import { buildAggregateExplainRequest, buildExplainContext } from '../lib/api';
import {
  effectiveVerdict,
  langTag,
  severityVar,
  toneOf,
  toneVar,
  verdictMeta,
  verdictWeight,
  type Verdict,
} from '../lib/trust';
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

// Consistent section header — matches the typographic rhythm of RootCauseCard
// so the two views read as one product.
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
      {children}
    </div>
  );
}

// A Root-Causes-style soft card. Sections of the inspector live in these so
// the inspector reads as a stack of distinct beats rather than a flat wall.
function Card({
  children,
  accent,
}: {
  children: ReactNode;
  // Optional left accent stripe (used for the verdict banner).
  accent?: string;
}) {
  const style: CSSProperties = accent
    ? { borderLeftColor: accent, borderLeftWidth: 3 }
    : {};
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3.5 shadow-elev1" style={style}>
      {children}
    </div>
  );
}

// §5C — the anchor of truth for a node. Reflects state from the selected node;
// holds no independent copy of node properties. Polished to match the Root
// Causes view: section-card stack, consistent labels, generous spacing.
export function Inspector({ node, graph, drift, aggregate, reachFilter }: InspectorProps) {
  // Aggregate mode takes precedence: list the real individual touches behind a
  // lane node. These are reads/writes Throughline detected — not UI renders.
  if (aggregate) {
    const aggregateExplain = graph
      ? buildAggregateExplainRequest(aggregate.title, aggregate.touches, graph)
      : null;

    return (
      <div className="flex h-full flex-col gap-4 overflow-y-auto p-5">
        <header>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            touches
          </div>
          <h2 className="mt-1 break-words font-mono text-lg text-neutral-100">{aggregate.title}</h2>
          <p className="mt-1 text-xs leading-relaxed text-neutral-400">
            {aggregate.touches.length} individual{' '}
            {aggregate.touches.length === 1 ? 'touch' : 'touches'} — reads/writes Throughline
            detected, not UI renders.
          </p>
        </header>
        <ul className="space-y-2">
          {aggregate.touches.map((t) => (
            <TouchExplainCard key={t.id} node={t} />
          ))}
        </ul>
        {aggregateExplain ? (
          <Card>
            <ExplainPanel node={aggregateExplain.node} context={aggregateExplain.context} />
          </Card>
        ) : null}
      </div>
    );
  }

  if (!node) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-sm leading-relaxed text-neutral-500">
        Select a node to inspect its source, trust level, and any drift it is involved in.
      </div>
    );
  }

  const verdict = effectiveVerdict(node);
  const tone = toneOf(node.kind, verdict);
  const color = toneVar(tone);
  const relatedDrift = drift.filter((d) => d.contractId === node.id);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-5">
      {/* Header — node identity */}
      <header>
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full" style={{ background: color }} />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            {node.kind}
          </span>
          {node.language ? (
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-300">
              {langTag(node.language)}
            </span>
          ) : null}
        </div>
        <h2 className="mt-1.5 break-words font-mono text-lg text-neutral-100">{node.label}</h2>
        {node.notes ? (
          <p className="mt-2 text-sm leading-relaxed text-neutral-300">{node.notes}</p>
        ) : null}
      </header>

      {/* Verdict banner — schemaMatch (aligned/mismatch) overrides trust when set.
          The worst verdicts pick up a stronger background tint so they pop. */}
      {verdict ? <VerdictBanner verdict={verdict} color={color} /> : null}

      {/* Columns — contracts only. With per-column read-usage verdicts when the
          analyzer provided them; otherwise the plain schema table. */}
      {node.columns && node.columnUsage && node.columnUsage.length > 0 ? (
        <Card>
          <ColumnUsageList
            columns={node.columns}
            usage={node.columnUsage}
            reachFilter={reachFilter}
          />
        </Card>
      ) : node.columns ? (
        <Card>
          <SectionLabel>Columns</SectionLabel>
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
        </Card>
      ) : null}

      {/* Source block — the grounded source of truth */}
      {node.source ? (
        <Card>
          <SectionLabel>Source</SectionLabel>
          <div className="font-mono text-xs text-neutral-400">
            <SourceLink source={node.source}>
              {node.source.filePath}:{node.source.startLine}
              {node.source.endLine !== node.source.startLine ? `-${node.source.endLine}` : ''}
            </SourceLink>
          </div>
          <pre className="mt-2 overflow-x-auto rounded-md border border-neutral-800 bg-black/60 p-3 font-mono text-xs leading-relaxed text-neutral-200">
            {node.source.snippet}
          </pre>
        </Card>
      ) : null}

      {/* Drift list — colored by severity */}
      {relatedDrift.length > 0 ? (
        <Card>
          <SectionLabel>Drift</SectionLabel>
          <ul className="space-y-2">
            {relatedDrift.map((d, i) => (
              <li
                key={i}
                className="rounded-md border px-3 py-2 text-sm"
                style={{ borderColor: severityVar(d.severity) }}
              >
                <span
                  className="text-[10px] font-semibold uppercase tracking-wider"
                  style={{ color: severityVar(d.severity) }}
                >
                  {d.severity}
                </span>
                <p className="mt-1 leading-relaxed text-neutral-200">{d.message}</p>
                <div className="mt-1 font-mono text-[11px] text-neutral-500">
                  {d.source.filePath}:{d.source.startLine}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* AI commentary — visually distinct from the grounded facts above. */}
      {graph ? (
        <Card>
          <ExplainPanel node={node} context={buildExplainContext(node, graph)} />
        </Card>
      ) : null}
    </div>
  );
}

// Verdict pill. Quiet weights get a thin outline; critical lifts off the page
// with a stronger tint + border. Color meaning is identical across weights —
// only pixel-weight shifts so the eye lands on the worst first.
function VerdictBanner({ verdict, color }: { verdict: Verdict; color: string }) {
  const weight = verdictWeight(verdict);
  const meta = verdictMeta(verdict);

  const tint =
    weight === 'critical'
      ? `color-mix(in oklab, ${color} 16%, transparent)`
      : weight === 'attention'
        ? `color-mix(in oklab, ${color} 10%, transparent)`
        : 'transparent';
  const borderWidth =
    weight === 'critical' ? 2 : weight === 'attention' ? 1.5 : 1;
  const dotPx = weight === 'critical' ? 11 : weight === 'attention' ? 10 : 9;

  return (
    <div
      className="flex items-start gap-2.5 rounded-md border px-3 py-2 text-sm"
      style={{
        borderColor: color,
        borderWidth,
        background: tint,
        color,
      }}
    >
      <span
        className="mt-1 shrink-0 rounded-full"
        style={{ background: color, width: dotPx, height: dotPx }}
      />
      <div className="min-w-0">
        <div className="font-semibold">{meta.label}</div>
        <div className="mt-0.5 text-xs leading-relaxed text-neutral-400">{meta.blurb}</div>
      </div>
    </div>
  );
}
