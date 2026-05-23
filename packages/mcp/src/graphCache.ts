import { buildGraph } from '@throughline/analyzer/buildGraph';
import type { Graph } from '@throughline/core';

export interface GraphCounts {
  nodes: number;
  contracts: number;
  touches: number;
  edges: number;
  drift: number;
  rootCauses: number;
  relationships: number;
}

export interface ReanalyzeSummary {
  repoPath: string;
  previous_analyzed_at: string;
  analyzed_at: string;
  counts: GraphCounts;
  deltas: GraphCounts; // new minus previous, per field
}

type Builder = (repoPath: string) => Promise<Graph>;

function countGraph(g: Graph): GraphCounts {
  return {
    nodes: g.nodes.length,
    contracts: g.nodes.filter((n) => n.kind === 'contract').length,
    touches: g.nodes.filter((n) => n.kind === 'touch').length,
    edges: g.edges.length,
    drift: g.drift.length,
    rootCauses: g.rootCauses?.length ?? 0,
    relationships: g.relationships?.length ?? 0,
  };
}

// Holds the analyzed Graph in memory. Built once on init(); reanalyze() is the
// ONLY way the facts change — it re-derives the whole graph from disk. Nothing
// here can set or override a verdict.
export class GraphCache {
  #graph: Graph | undefined;

  constructor(
    private readonly repoPath: string,
    private readonly builder: Builder = buildGraph,
  ) {}

  get graph(): Graph {
    if (!this.#graph) throw new Error('GraphCache not initialized — call init()');
    return this.#graph;
  }

  async init(): Promise<void> {
    this.#graph = await this.builder(this.repoPath);
  }

  async reanalyze(): Promise<ReanalyzeSummary> {
    const previous = this.graph;
    const prevCounts = countGraph(previous);
    const next = await this.builder(this.repoPath);
    this.#graph = next;
    const counts = countGraph(next);
    const deltas: GraphCounts = {
      nodes: counts.nodes - prevCounts.nodes,
      contracts: counts.contracts - prevCounts.contracts,
      touches: counts.touches - prevCounts.touches,
      edges: counts.edges - prevCounts.edges,
      drift: counts.drift - prevCounts.drift,
      rootCauses: counts.rootCauses - prevCounts.rootCauses,
      relationships: counts.relationships - prevCounts.relationships,
    };
    return {
      repoPath: this.repoPath,
      previous_analyzed_at: previous.generatedAt,
      analyzed_at: next.generatedAt,
      counts,
      deltas,
    };
  }
}
