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
// so the web app always renders something. An undefined `repoPath` lets the
// analyzer fall back to its hardcoded default (Batch-Guard.ai-2).
export async function fetchGraph(repoPath?: string): Promise<GraphResult> {
  try {
    const qs = repoPath ? `?path=${encodeURIComponent(repoPath)}` : '';
    const res = await fetch(`${ANALYZER_URL}/analyze${qs}`);
    if (!res.ok) throw new Error(`analyzer responded ${res.status}`);
    const graph = (await res.json()) as Graph;
    return { graph, live: true };
  } catch {
    return { graph: sampleGraph, live: false };
  }
}

export interface McpConfigInfo {
  throughlineRoot: string;
  mcpEntry: string;
  tsxBinPosix: string;
  tsxBinWindows: string;
  // Node's `process.platform` string ('darwin' | 'win32' | 'linux' | ...).
  // Kept as a free-form string so the web type doesn't need @types/node.
  platform: string;
}

// Ask the analyzer for the absolute paths needed to construct an MCP install
// snippet for the user's machine. Resolved server-side because the browser
// has no way to know where the user's throughline checkout lives on disk.
export async function fetchMcpConfigInfo(): Promise<McpConfigInfo> {
  const res = await fetch(`${ANALYZER_URL}/mcp-config`);
  if (!res.ok) throw new Error(`mcp-config responded ${res.status}`);
  return (await res.json()) as McpConfigInfo;
}

export type PickFolderResult =
  | { path: string }
  | { cancelled: true }
  | { error: string };

// Ask the analyzer to open a native folder picker dialog (osascript on macOS,
// PowerShell FolderBrowserDialog on Windows, zenity on Linux). The analyzer
// returns an absolute path the user can hand back to /analyze.
export async function pickFolder(): Promise<PickFolderResult> {
  try {
    const res = await fetch(`${ANALYZER_URL}/pick-folder`, { method: 'POST' });
    const data = (await res.json().catch(() => ({}))) as PickFolderResult & { error?: string };
    if (!res.ok) {
      return { error: data.error ?? `Folder picker failed (${res.status})` };
    }
    return data;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
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
