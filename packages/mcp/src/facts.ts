import {
  ANALYZER_DEPTH,
  TRUST_REASON_DESCRIPTIONS,
  type GraphNode,
  type SourceRef,
  type Trust,
  type TrustReason,
  type SchemaMatch,
  type Language,
} from '@throughline/core';

export type Confidence = 'certain' | 'heuristic';
export interface Scope {
  level: 'table' | 'column';
  depth: 'deep' | 'shallow';
}

// Deep when ts-morph resolved it (typescript) or a Rust write was deep-parsed
// against its struct (schemaMatch present). Everything else is shallow grep.
// Contracts (SQL) are parsed schema -> deep.
export function depthForNode(node: GraphNode): 'deep' | 'shallow' {
  if (node.schemaMatch) return 'deep';
  if (node.kind === 'contract') return 'deep';
  const lang = node.language as Language | undefined;
  if (lang && ANALYZER_DEPTH[lang] === 'deep') return 'deep';
  return 'shallow';
}

export function confidenceForNode(node: GraphNode): Confidence {
  return depthForNode(node) === 'deep' ? 'certain' : 'heuristic';
}

export interface TouchFact {
  nodeId: string;
  label: string;
  language?: Language;
  trust?: Trust;
  trustReason?: TrustReason;
  // The analyzer's OWN canonical description of the reason (from
  // TRUST_REASON_DESCRIPTIONS in @throughline/core) — not invented per call.
  reasonDescription: string;
  schemaMatch?: SchemaMatch;
  confidence: Confidence;
  scope: Scope;
  source?: SourceRef;
}

export function touchFact(node: GraphNode): TouchFact {
  return {
    nodeId: node.id,
    label: node.label,
    language: node.language,
    trust: node.trust,
    trustReason: node.trustReason,
    reasonDescription: node.trustReason
      ? TRUST_REASON_DESCRIPTIONS[node.trustReason]
      : '',
    schemaMatch: node.schemaMatch,
    confidence: confidenceForNode(node),
    scope: { level: 'table', depth: depthForNode(node) },
    source: node.source,
  };
}
