import type { EdgeDirection, Graph, GraphNode, Language, Trust } from '@throughline/core';

export const ALL_TRUST: Trust[] = ['verified', 'narrowed', 'asserted', 'dark'];
export const ALL_LANGS: Language[] = ['sql', 'typescript', 'python', 'rust'];
export const ALL_DIRECTIONS: EdgeDirection[] = ['read', 'write'];

export interface FilterState {
  trust: Set<Trust>;
  languages: Set<Language>;
  directions: Set<EdgeDirection>;
  focusContractId: string | null;
}

export function defaultFilterState(): FilterState {
  return {
    trust: new Set(ALL_TRUST),
    languages: new Set(ALL_LANGS),
    directions: new Set(ALL_DIRECTIONS),
    focusContractId: null,
  };
}

export function isDefault(f: FilterState): boolean {
  return (
    f.focusContractId === null &&
    f.trust.size === ALL_TRUST.length &&
    f.languages.size === ALL_LANGS.length &&
    f.directions.size === ALL_DIRECTIONS.length
  );
}

// Toggle a value in a Set immutably (so React sees a new reference).
export function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

// Derive a filtered subgraph. The contract spine only keeps tables that still
// have a visible touch (or the focused one), so turning trust/language off
// genuinely declutters — and the smaller graph re-runs Dagre cheaply.
export function applyFilters(graph: Graph, f: FilterState): Graph {
  const dirOf = new Map<string, EdgeDirection>();
  for (const e of graph.edges) dirOf.set(e.source, e.direction);

  // Focus mode: restrict to the focused contract + its directly-connected touches.
  let focusNeighbors: Set<string> | null = null;
  if (f.focusContractId) {
    focusNeighbors = new Set<string>([f.focusContractId]);
    for (const e of graph.edges) {
      if (e.target === f.focusContractId) focusNeighbors.add(e.source);
      if (e.source === f.focusContractId) focusNeighbors.add(e.target);
    }
  }

  const touchPasses = (n: GraphNode): boolean => {
    if (focusNeighbors && !focusNeighbors.has(n.id)) return false;
    if (n.trust && !f.trust.has(n.trust)) return false;
    if (n.language && !f.languages.has(n.language)) return false;
    const dir = dirOf.get(n.id);
    if (dir && !f.directions.has(dir)) return false;
    return true;
  };

  const visibleTouches = new Set<string>();
  for (const n of graph.nodes) {
    if (n.kind !== 'contract' && touchPasses(n)) visibleTouches.add(n.id);
  }

  const candidateEdges = graph.edges.filter(
    (e) =>
      visibleTouches.has(e.source) &&
      (!f.focusContractId || e.target === f.focusContractId),
  );
  const contractsWithTouch = new Set(candidateEdges.map((e) => e.target));

  const nodes = graph.nodes.filter((n) => {
    if (n.kind === 'contract') {
      if (!f.languages.has('sql')) return false;
      return f.focusContractId ? n.id === f.focusContractId : contractsWithTouch.has(n.id);
    }
    return visibleTouches.has(n.id);
  });

  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = candidateEdges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

  return { ...graph, nodes, edges };
}
