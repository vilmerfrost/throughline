import type { Graph, GraphNode, RootCause, Trust, UnresolvedShape } from '@throughline/core';

// RC-b view-model: a pure read over graph.rootCauses (produced by the analyzer).
// It never invents data — affected touches are resolved from the real node ids,
// and every fix lever points at a real construction site or signature SourceRef.

export type RootCauseClass = 'resolved' | UnresolvedShape;

export interface RootCauseRow {
  rc: RootCause;
  key: string;
  klass: RootCauseClass;
  // Only resolved (construction site) and parameter (signatures) have a single
  // place to fix — the others are honestly "no one-click lever".
  actionable: boolean;
  affectedTouches: GraphNode[]; // resolved from affectedTouchIds — grounded, may be empty
}

export function classOf(rc: RootCause): RootCauseClass {
  if (rc.origin.name !== 'unresolved-origin') return 'resolved';
  return rc.origin.shape ?? 'other';
}

// Stable identity matching the analyzer's grouping key (reason + origin site/shape).
export function rootCauseKey(rc: RootCause): string {
  const loc = rc.origin.source
    ? `${rc.origin.source.filePath}:${rc.origin.source.startLine}`
    : (rc.origin.shape ?? 'other');
  return `${rc.reason}::${rc.origin.name}::${loc}`;
}

export function buildRootCauseRows(graph: Graph): RootCauseRow[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // Preserve the analyzer's biggest-lever-first ranking.
  return (graph.rootCauses ?? []).map((rc) => {
    const klass = classOf(rc);
    return {
      rc,
      key: rootCauseKey(rc),
      klass,
      actionable: klass === 'resolved' || klass === 'parameter',
      affectedTouches: rc.affectedTouchIds
        .map((id) => byId.get(id))
        .filter((n): n is GraphNode => Boolean(n)),
    };
  });
}

// Reason → the trust the synthetic fix-prompt node should carry. (The fix-prompt
// builder keys its recipe on trustReason; trust is only for display parity.)
const REASON_TRUST: Record<string, Trust> = {
  'ts-cast-concrete': 'asserted',
  'ts-cast-any': 'dark',
  'ts-bypass-any': 'dark',
  'ts-loose-client': 'dark',
};

// Build a fix-prompt request that targets the ROOT (construction site or the
// captured signatures) and lists EVERY affected call site — so the existing
// /fix-prompt recipe drives a "fix the root, not one touch" task. Mirrors
// buildAggregateExplainRequest so the server sees a familiar shape.
export function buildRootCauseFixRequest(
  row: RootCauseRow,
  graph: Graph,
): { node: GraphNode; context: Record<string, unknown> } {
  const { rc } = row;
  const trust = REASON_TRUST[rc.reason] ?? 'dark';

  // The single place to fix: the construction site (resolved) or the first
  // captured parameter signature (parameter). Both are real SourceRefs.
  const fixSource = rc.origin.source ?? rc.evidence?.[0];

  const node: GraphNode = {
    id: `rootcause:${row.key}`,
    kind: 'touch',
    language: 'typescript',
    label:
      rc.origin.name === 'unresolved-origin' ? `${rc.origin.shape ?? 'client'} client` : rc.origin.name,
    trust,
    trustReason: rc.reason,
    source: fixSource,
    notes: `Root cause: explains ${rc.affectedCount} touch(es) across ${rc.affectedContracts.length} contract(s): ${rc.affectedContracts.join(', ')}.`,
  };

  // "Files to change": the signature fix-sites first (parameter shape only, since
  // resolved already shows its construction site as the verbatim source), then
  // every affected call site so the agent sees the full scope it's flipping.
  const signatureTouches = (rc.origin.source ? [] : (rc.evidence ?? [])).map((s) => ({
    language: 'typescript' as const,
    direction: 'read' as const,
    trust,
    trustReason: rc.reason,
    source: s,
  }));
  const affectedTouches = row.affectedTouches.map((t) => {
    const edge = graph.edges.find((e) => e.source === t.id);
    return {
      language: t.language,
      direction: edge?.direction ?? 'read',
      trust: t.trust,
      trustReason: t.trustReason,
      source: t.source,
    };
  });

  return {
    node,
    context: {
      repoPath: graph.repoPath,
      touches: [...signatureTouches, ...affectedTouches],
    },
  };
}
