import {
  ANALYZER_DEPTH,
  TRUST_REASON_DESCRIPTIONS,
  type GraphNode,
  type SourceRef,
  type Trust,
  type TrustReason,
  type SchemaMatch,
  type Language,
  type Graph,
  type ColumnReach,
  type Cardinality,
  type DriftFinding,
  type EdgeDirection,
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

// --- shared lookups -------------------------------------------------------

function contractNode(graph: Graph, table: string): GraphNode | undefined {
  return graph.nodes.find(
    (n) => n.kind === 'contract' && n.label === table,
  );
}

function isKnownContract(graph: Graph, table: string): boolean {
  return graph.nodes.some((n) => n.kind === 'contract' && n.label === table);
}

function touchesForContract(
  graph: Graph,
  contractId: string,
): { readers: GraphNode[]; writers: GraphNode[] } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const readers: GraphNode[] = [];
  const writers: GraphNode[] = [];
  for (const e of graph.edges) {
    if (e.target !== contractId) continue;
    const touch = byId.get(e.source);
    if (!touch) continue;
    (e.direction === 'write' ? writers : readers).push(touch);
  }
  return { readers, writers };
}

// --- FK neighbors ---------------------------------------------------------

export interface FkNeighbor {
  direction: 'references' | 'referenced-by';
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  cardinality: Cardinality;
  external: boolean; // the OTHER table is not a known contract in this graph
  source: SourceRef;
}

export function fkNeighbors(table: string, graph: Graph): FkNeighbor[] {
  const rels = graph.relationships ?? [];
  const out: FkNeighbor[] = [];
  for (const r of rels) {
    if (r.fromTable === table) {
      out.push({
        direction: 'references',
        fromTable: r.fromTable,
        fromColumn: r.fromColumn,
        toTable: r.toTable,
        toColumn: r.toColumn,
        cardinality: r.cardinality,
        external: !isKnownContract(graph, r.toTable),
        source: r.source,
      });
    }
    if (r.toTable === table) {
      out.push({
        direction: 'referenced-by',
        fromTable: r.fromTable,
        fromColumn: r.fromColumn,
        toTable: r.toTable,
        toColumn: r.toColumn,
        cardinality: r.cardinality,
        external: !isKnownContract(graph, r.fromTable),
        source: r.source,
      });
    }
  }
  return out;
}

// --- table facts ----------------------------------------------------------

export interface ColumnFact {
  name: string;
  type: string;
  nullable?: boolean;
  hasDefault?: boolean;
  reach?: ColumnReach;
  reachConfidence?: Confidence;
  escapeTrail?: SourceRef[];
}

export interface DriftFact {
  message: string;
  severity: DriftFinding['severity'];
  source: SourceRef;
}

export interface TableFacts {
  table: string;
  found: boolean;
  analyzed_at: string;
  columns: ColumnFact[];
  touches: { writers: TouchFact[]; readers: TouchFact[] };
  drift: DriftFact[];
  fkNeighbors: FkNeighbor[];
  scope: { level: 'table' };
}

export function getTableFacts(name: string, graph: Graph): TableFacts {
  const contract = contractNode(graph, name);
  const base: TableFacts = {
    table: name,
    found: Boolean(contract),
    analyzed_at: graph.generatedAt,
    columns: [],
    touches: { writers: [], readers: [] },
    drift: [],
    fkNeighbors: fkNeighbors(name, graph),
    scope: { level: 'table' },
  };
  if (!contract) return base;

  const usageByCol = new Map(
    (contract.columnUsage ?? []).map((u) => [u.column, u]),
  );
  base.columns = (contract.columns ?? []).map((c) => {
    const u = usageByCol.get(c.name);
    return {
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      hasDefault: c.hasDefault,
      reach: u?.reach,
      reachConfidence: u
        ? u.certain
          ? 'certain'
          : 'heuristic'
        : undefined,
      escapeTrail: u?.escapeTrail,
    };
  });

  const { readers, writers } = touchesForContract(graph, contract.id);
  base.touches.readers = readers.map(touchFact);
  base.touches.writers = writers.map(touchFact);

  base.drift = graph.drift
    .filter((d) => d.contractId === contract.id)
    .map((d) => ({ message: d.message, severity: d.severity, source: d.source }));

  return base;
}

// --- file facts -----------------------------------------------------------

export interface FileTouchFact extends TouchFact {
  direction?: EdgeDirection; // read/write toward the table(s)
  tablesTouched: string[];
}

export interface FileFacts {
  path: string;
  found: boolean;
  analyzed_at: string;
  touches: FileTouchFact[];
}

// Normalize an incoming path to the repo-relative form stored on SourceRef.
function toRelative(graph: Graph, p: string): string {
  const root = graph.repoPath.endsWith('/') ? graph.repoPath : graph.repoPath + '/';
  return p.startsWith(root) ? p.slice(root.length) : p;
}

export function getFileFacts(path: string, graph: Graph): FileFacts {
  const rel = toRelative(graph, path);
  const labelById = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const edgesBySource = new Map<string, typeof graph.edges>();
  for (const e of graph.edges) {
    const arr = edgesBySource.get(e.source) ?? [];
    arr.push(e);
    edgesBySource.set(e.source, arr);
  }

  const touches: FileTouchFact[] = graph.nodes
    .filter((n) => n.kind === 'touch' && n.source?.filePath === rel)
    .map((n) => {
      const edges = edgesBySource.get(n.id) ?? [];
      const tablesTouched = [
        ...new Set(edges.map((e) => labelById.get(e.target) ?? e.target)),
      ];
      return {
        ...touchFact(n),
        direction: edges[0]?.direction,
        tablesTouched,
      };
    });

  return {
    path: rel,
    found: touches.length > 0,
    analyzed_at: graph.generatedAt,
    touches,
  };
}

// --- node context -----------------------------------------------------------

export interface NodeContext {
  found: boolean;
  analyzed_at: string;
  node?: TouchFact;
  contract?: { table: string; columns: ColumnFact[] };
  neighbors: {
    siblingTouches: TouchFact[]; // other touches on the same contract (capped)
    fkNeighbors: FkNeighbor[];
  };
}

const SIBLING_CAP = 20;

export function getNodeContext(nodeId: string, graph: Graph): NodeContext {
  const node = graph.nodes.find((n) => n.id === nodeId && n.kind === 'touch');
  const empty: NodeContext = {
    found: Boolean(node),
    analyzed_at: graph.generatedAt,
    neighbors: { siblingTouches: [], fkNeighbors: [] },
  };
  if (!node) return empty;

  empty.node = touchFact(node);

  // The contract this touch points at (via its edge target).
  const edge = graph.edges.find((e) => e.source === node.id);
  if (edge) {
    const contract = graph.nodes.find(
      (n) => n.id === edge.target && n.kind === 'contract',
    );
    if (contract) {
      const usageByCol = new Map(
        (contract.columnUsage ?? []).map((u) => [u.column, u]),
      );
      empty.contract = {
        table: contract.label,
        columns: (contract.columns ?? []).map((c) => {
          const u = usageByCol.get(c.name);
          return {
            name: c.name,
            type: c.type,
            nullable: c.nullable,
            hasDefault: c.hasDefault,
            reach: u?.reach,
            reachConfidence: u ? (u.certain ? 'certain' : 'heuristic') : undefined,
            escapeTrail: u?.escapeTrail,
          };
        }),
      };
      const { readers, writers } = touchesForContract(graph, contract.id);
      empty.neighbors.siblingTouches = [...readers, ...writers]
        .filter((t) => t.id !== node.id)
        .slice(0, SIBLING_CAP)
        .map(touchFact);
      empty.neighbors.fkNeighbors = fkNeighbors(contract.label, graph);
    }
  }

  return empty;
}
