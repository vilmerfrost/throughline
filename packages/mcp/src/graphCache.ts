import { buildGraph } from '@throughline/analyzer/buildGraph';
import type { Graph } from '@throughline/core';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

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

export type AnalysisTargetSource = 'argv' | 'env' | 'default' | 'runtime';

export interface AnalysisTargetStatus {
  repoPath: string;
  resolved_from: AnalysisTargetSource;
  analyzed_at?: string;
  ready: boolean;
  counts: GraphCounts;
  warnings: string[];
  hints: string[];
}

export interface SetAnalysisTargetInput {
  path: string;
  reason?: string;
}

export interface SetAnalysisTargetSummary {
  previous: {
    repoPath: string;
    resolved_from: AnalysisTargetSource;
    analyzed_at: string;
    counts: GraphCounts;
  };
  current: AnalysisTargetStatus;
  reason?: string;
}

type Builder = (repoPath: string) => Promise<Graph>;

const ZERO_COUNTS: GraphCounts = {
  nodes: 0,
  contracts: 0,
  touches: 0,
  edges: 0,
  drift: 0,
  rootCauses: 0,
  relationships: 0,
};

export function countGraph(g: Graph): GraphCounts {
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
  #repoPath: string;
  #resolvedFrom: AnalysisTargetSource;

  constructor(
    repoPath: string,
    private readonly builder: Builder = buildGraph,
    resolvedFrom: AnalysisTargetSource = 'default',
  ) {
    this.#repoPath = resolve(repoPath);
    this.#resolvedFrom = resolvedFrom;
  }

  get graph(): Graph {
    if (!this.#graph) throw new Error('GraphCache not initialized — call init()');
    return this.#graph;
  }

  async init(): Promise<void> {
    this.#graph = await this.builder(this.#repoPath);
  }

  getAnalysisTarget(): AnalysisTargetStatus {
    const graph = this.#graph;
    return {
      repoPath: this.#repoPath,
      resolved_from: this.#resolvedFrom,
      analyzed_at: graph?.generatedAt,
      ready: Boolean(graph),
      counts: graph ? countGraph(graph) : ZERO_COUNTS,
      warnings: targetWarnings(this.#repoPath, graph),
      hints: [
        'Call get_analysis_target first to confirm Throughline is pointed at your current workspace.',
        'If the target is wrong, call set_analysis_target with the absolute or relative repo path before asking for table/file facts.',
        'After editing code on disk, call reanalyze to refresh this same target.',
      ],
    };
  }

  async setAnalysisTarget(input: SetAnalysisTargetInput): Promise<SetAnalysisTargetSummary> {
    const previous = this.graph;
    const previousCounts = countGraph(previous);
    const previousRepoPath = this.#repoPath;
    const previousResolvedFrom = this.#resolvedFrom;
    const nextRepoPath = await resolveDirectory(input.path);
    const nextGraph = await this.builder(nextRepoPath);

    this.#repoPath = nextRepoPath;
    this.#resolvedFrom = 'runtime';
    this.#graph = nextGraph;

    return {
      previous: {
        repoPath: previousRepoPath,
        resolved_from: previousResolvedFrom,
        analyzed_at: previous.generatedAt,
        counts: previousCounts,
      },
      current: this.getAnalysisTarget(),
      reason: input.reason,
    };
  }

  async reanalyze(): Promise<ReanalyzeSummary> {
    const previous = this.graph;
    const prevCounts = countGraph(previous);
    const next = await this.builder(this.#repoPath);
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
      repoPath: this.#repoPath,
      previous_analyzed_at: previous.generatedAt,
      analyzed_at: next.generatedAt,
      counts,
      deltas,
    };
  }
}

async function resolveDirectory(path: string): Promise<string> {
  const repoPath = resolve(path);
  let info;
  try {
    info = await stat(repoPath);
  } catch {
    throw new Error(`Analysis target does not exist: ${repoPath}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Analysis target is not a directory: ${repoPath}`);
  }
  return repoPath;
}

function targetWarnings(repoPath: string, graph: Graph | undefined): string[] {
  const warnings: string[] = [];
  if (graph && graph.repoPath !== repoPath) {
    warnings.push(`Cached graph repoPath (${graph.repoPath}) differs from target (${repoPath}).`);
  }
  if (graph && graph.nodes.length === 0) {
    warnings.push('Analyzer returned an empty graph; confirm the target has supported SQL/TypeScript/Python/Rust files.');
  }
  return warnings;
}
