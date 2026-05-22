import type { Graph, GraphNode } from '@throughline/core';
import { sampleGraph } from '../mock/sampleGraph';

const ANALYZER_URL = 'http://localhost:4000';

export type ExplainMode = 'focused' | 'repo';

export interface ExplainSource {
  label: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  snippet: string;
  uri?: string;
}

export interface ExplainResult {
  explanation: string;
  structured?: StructuredExplanation;
  sources: ExplainSource[];
  model?: string;
}

export interface StructuredExplanation {
  recap: string;
  what: string;
  evidence: string;
  risk: string;
  actions: string;
  conclusion: string;
}

export interface GraphResult {
  graph: Graph;
  live: boolean; // true = from analyzer, false = local mock fallback
}

export function buildAggregateExplainRequest(
  title: string,
  touches: GraphNode[],
  graph: Graph,
): { node: GraphNode; context: Record<string, unknown> } {
  const firstTouch = touches[0];
  const firstEdge = firstTouch ? graph.edges.find((e) => e.source === firstTouch.id) : undefined;
  const contractNode = firstEdge ? graph.nodes.find((n) => n.id === firstEdge.target) : undefined;
  const trust = touches.some((touch) => touch.trust === 'dark')
    ? 'dark'
    : touches.some((touch) => touch.trust === 'asserted')
      ? 'asserted'
      : touches.some((touch) => touch.trust === 'narrowed')
        ? 'narrowed'
        : 'verified';
  const trustReason = firstTouch?.trustReason;
  const node: GraphNode = {
    id: `aggregate:${title}`,
    kind: 'touch',
    label: title,
    language: firstTouch?.language,
    trust,
    trustReason,
    notes: `${touches.length} grouped touches selected from the graph.`,
  };

  return {
    node,
    context: {
      repoPath: graph.repoPath,
      contract: contractNode
        ? { table: contractNode.label, columns: contractNode.columns, source: contractNode.source }
        : undefined,
      touches: touches.map((touch) => {
        const edge = graph.edges.find((e) => e.source === touch.id);
        return {
          language: touch.language,
          direction: edge?.direction ?? 'unknown',
          trust: touch.trust,
          trustReason: touch.trustReason,
          source: touch.source,
        };
      }),
      drift: contractNode
        ? graph.drift.filter((d) => d.contractId === contractNode.id).map((d) => d.message)
        : [],
    },
  };
}

// Fetch the graph from the analyzer; fall back to the bundled mock on any error
// so the web app always renders something.
export async function fetchGraph(
  repoPath = '/Users/vilmerfrost/Projects/batchgaurd.ai-2',
): Promise<GraphResult> {
  try {
    const res = await fetch(`${ANALYZER_URL}/analyze?path=${encodeURIComponent(repoPath)}`);
    if (!res.ok) throw new Error(`analyzer responded ${res.status}`);
    const graph = (await res.json()) as Graph;
    return { graph, live: true };
  } catch {
    return { graph: sampleGraph, live: false };
  }
}

// Build the facts-only context for a node from the graph the frontend already
// holds. The server formats this into the prompt; the API key never comes here.
export function buildExplainContext(node: GraphNode, graph: Graph): Record<string, unknown> {
  if (node.kind === 'contract') {
    const touches = graph.edges
      .filter((e) => e.target === node.id)
      .map((e) => {
        const touch = graph.nodes.find((n) => n.id === e.source);
        return {
          language: touch?.language,
          direction: e.direction,
          trust: touch?.trust,
          trustReason: touch?.trustReason,
          source: touch?.source,
        };
      });
    return {
      repoPath: graph.repoPath,
      columns: node.columns,
      touches,
      drift: graph.drift.filter((d) => d.contractId === node.id).map((d) => d.message),
    };
  }

  // touch node: find the contract it targets
  const edge = graph.edges.find((e) => e.source === node.id);
  const contractNode = edge ? graph.nodes.find((n) => n.id === edge.target) : undefined;
  return {
    repoPath: graph.repoPath,
    contract: contractNode
      ? { table: contractNode.label, columns: contractNode.columns, source: contractNode.source }
      : undefined,
    drift: edge
      ? graph.drift.filter((d) => d.contractId === edge.target).map((d) => d.message)
      : [],
  };
}

export type FixPromptKind = 'code-fix' | 'analyzer-only' | 'no-fix-needed';

export interface FixPromptResult {
  kind: FixPromptKind;
  summary: string;
  prompt: string;
}

// Ask the analyzer for a deterministic, copy-paste-ready fix prompt. No LLM
// call: each TrustReason maps to one templated recipe.
export async function fetchFixPrompt(
  node: GraphNode,
  context: Record<string, unknown>,
): Promise<FixPromptResult> {
  const res = await fetch(`${ANALYZER_URL}/fix-prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ node, context }),
  });
  const data = (await res.json().catch(() => ({}))) as FixPromptResult & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Fix prompt failed (${res.status})`);
  return {
    kind: data.kind ?? 'no-fix-needed',
    summary: data.summary ?? '',
    prompt: data.prompt ?? '',
  };
}

// Ask the analyzer to explain a node. Throws with the server's error message on
// failure so the caller can show it inline.
export async function explainNode(
  node: GraphNode,
  context: Record<string, unknown>,
  options: { prompt?: string; mode?: ExplainMode } = {},
): Promise<ExplainResult> {
  const res = await fetch(`${ANALYZER_URL}/explain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      node,
      context: {
        ...context,
        mode: options.mode ?? 'focused',
        userPrompt: options.prompt,
      },
    }),
  });
  const data = (await res.json().catch(() => ({}))) as ExplainResult & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Explain failed (${res.status})`);
  return {
    explanation: data.explanation ?? '',
    structured: data.structured,
    sources: data.sources ?? [],
    model: data.model,
  };
}
