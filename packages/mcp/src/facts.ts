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
  type RootCause,
  type SourceScope,
  type UnresolvedShape,
} from '@throughline/core';
import { compareWriteFields } from '@throughline/analyzer/schema/compareFields';

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
  sourceScope?: SourceScope;
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
    sourceScope: node.sourceScope,
    source: node.source,
  };
}

export type SourceScopeFilter = SourceScope | 'all';
export interface FactFilter {
  scope?: SourceScopeFilter;
  includeTests?: boolean;
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
  filter: FactFilter = {},
): { readers: GraphNode[]; writers: GraphNode[]; excludedTouches: Partial<Record<SourceScope, number>> } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const readers: GraphNode[] = [];
  const writers: GraphNode[] = [];
  const excludedTouches: Partial<Record<SourceScope, number>> = {};
  for (const e of graph.edges) {
    if (e.target !== contractId) continue;
    const touch = byId.get(e.source);
    if (!touch) continue;
    if (!matchesFilter(touch, filter)) {
      const scope = touch.sourceScope ?? 'unknown';
      excludedTouches[scope] = (excludedTouches[scope] ?? 0) + 1;
      continue;
    }
    (e.direction === 'write' ? writers : readers).push(touch);
  }
  return { readers, writers, excludedTouches };
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
  scopeBreakdown?: Partial<Record<SourceScope, number>>;
  productionImpact?: boolean;
  testOnly?: boolean;
}

export interface TableFacts {
  table: string;
  found: boolean;
  analyzed_at: string;
  columns: ColumnFact[];
  touches: { writers: TouchFact[]; readers: TouchFact[] };
  touchesByScope?: Partial<Record<SourceScope, { writers: TouchFact[]; readers: TouchFact[] }>>;
  excludedTouches?: Partial<Record<SourceScope, number>>;
  drift: DriftFact[];
  fkNeighbors: FkNeighbor[];
  scope: { level: 'table' };
}

export function getTableFacts(name: string, graph: Graph, filter: FactFilter = {}): TableFacts {
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

  const { readers, writers, excludedTouches } = touchesForContract(graph, contract.id, filter);
  base.touches.readers = readers.map(touchFact);
  base.touches.writers = writers.map(touchFact);
  if (Object.keys(excludedTouches).length > 0) base.excludedTouches = excludedTouches;
  if ((filter.scope ?? 'all') === 'all') {
    base.touchesByScope = groupTouchesByScope(writers, readers);
  }

  base.drift = graph.drift
    .filter((d) => d.contractId === contract.id)
    .map((d) => ({
      message: d.message,
      severity: d.severity,
      source: d.source,
      scopeBreakdown: d.scopeBreakdown,
      productionImpact: d.productionImpact,
      testOnly: d.testOnly,
    }));

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

export function getFileFacts(path: string, graph: Graph, filter: FactFilter = {}): FileFacts {
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
    .filter((n) => matchesFilter(n, filter))
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

// --- root cause facts -------------------------------------------------------

export interface RootCauseFact {
  reason: TrustReason;
  reasonDescription: string;
  origin: { name: string; shape?: UnresolvedShape; source?: SourceRef };
  affectedCount: number;
  affectedTouchIds: string[];
  affectedContracts: string[];
  evidence?: SourceRef[];
  scopeBreakdown?: Partial<Record<SourceScope, number>>;
  productionImpact?: boolean;
  testOnly?: boolean;
  // The rollup is a deterministic grouping of already-resolved analyzer facts,
  // so the lever itself is certain. (Individual touches keep their own.)
  confidence: Confidence;
}

export interface RootCauseFacts {
  analyzed_at: string;
  rootCauses: RootCauseFact[];
}

export function getRootCauseFacts(graph: Graph, filter: FactFilter = {}): RootCauseFacts {
  const ranked: RootCause[] = graph.rootCauses ?? [];
  const touchById = new Map(graph.nodes.map((n) => [n.id, n]));
  return {
    analyzed_at: graph.generatedAt,
    rootCauses: ranked.flatMap((rc) => {
      const scopedTouchIds = rc.affectedTouchIds.filter((id) => {
        const node = touchById.get(id);
        return node ? matchesFilter(node, filter) : true;
      });
      if (scopedTouchIds.length === 0) return [];
      const scopedContracts = new Set<string>();
      for (const edge of graph.edges) {
        if (!scopedTouchIds.includes(edge.source)) continue;
        const contract = graph.nodes.find((n) => n.id === edge.target && n.kind === 'contract');
        if (contract) scopedContracts.add(contract.label);
      }
      const scopeBreakdown = breakdownScopes(scopedTouchIds.map((id) => touchById.get(id)).filter(Boolean) as GraphNode[]);
      return [{
        reason: rc.reason,
        reasonDescription: TRUST_REASON_DESCRIPTIONS[rc.reason],
        origin: { name: rc.origin.name, shape: rc.origin.shape, source: rc.origin.source },
        affectedCount: scopedTouchIds.length,
        affectedTouchIds: scopedTouchIds,
        affectedContracts: [...scopedContracts].sort(),
        evidence: rc.evidence,
        scopeBreakdown,
        productionImpact: (scopeBreakdown.production ?? 0) > 0,
        testOnly: Object.keys(scopeBreakdown).length === 1 && (scopeBreakdown.test ?? 0) > 0,
        confidence: 'certain' as const,
      }];
    }),
  };
}

function matchesFilter(node: GraphNode, filter: FactFilter): boolean {
  if (filter.includeTests === false && node.sourceScope === 'test') return false;
  const scope = filter.scope ?? 'all';
  if (scope === 'all') return true;
  return (node.sourceScope ?? 'unknown') === scope;
}

function groupTouchesByScope(
  writers: GraphNode[],
  readers: GraphNode[],
): Partial<Record<SourceScope, { writers: TouchFact[]; readers: TouchFact[] }>> {
  const out: Partial<Record<SourceScope, { writers: TouchFact[]; readers: TouchFact[] }>> = {};
  for (const node of writers) {
    const scope = node.sourceScope ?? 'unknown';
    const slot = out[scope] ?? { writers: [], readers: [] };
    slot.writers.push(touchFact(node));
    out[scope] = slot;
  }
  for (const node of readers) {
    const scope = node.sourceScope ?? 'unknown';
    const slot = out[scope] ?? { writers: [], readers: [] };
    slot.readers.push(touchFact(node));
    out[scope] = slot;
  }
  return out;
}

function breakdownScopes(nodes: GraphNode[]): Partial<Record<SourceScope, number>> {
  const out: Partial<Record<SourceScope, number>> = {};
  for (const node of nodes) {
    const scope = node.sourceScope ?? 'unknown';
    out[scope] = (out[scope] ?? 0) + 1;
  }
  return out;
}

// --- check_write (preventive, PURE) -----------------------------------------

export type CheckWriteVerb = 'insert' | 'update';
export type WriteVerdict = 'would_align' | 'would_mismatch';

export interface CheckWriteResult {
  table: string;
  found: boolean; // is `table` a scanned contract in this graph?
  verb: CheckWriteVerb;
  verdict?: WriteVerdict; // omitted entirely for an unknown table — never fabricated
  missingRequired: string[]; // insert-only: NOT-NULL-without-default columns absent
  unknownKeys: string[]; // proposed field names that are not columns
  checkedAgainst: string[]; // grounding: the schema columns this was compared to
  // Honest scope label. NOT 'verified': names + presence only, no value type-check,
  // and only as of analyzed_at — not a runtime or compiler guarantee.
  scope: 'column-level · schema-snapshot';
  analyzed_at: string;
  note: string;
}

const CHECK_WRITE_CAVEAT =
  'Schema-snapshot check as of analyzed_at: field NAMES + presence only — values are NOT ' +
  'type-checked, and this is NOT a runtime or compiler guarantee. If the schema may have ' +
  'changed since analyzed_at, call reanalyze() first.';

// PURE EVALUATION. Validates a PROPOSED write against the schema BEFORE the code
// is written. Changes NOTHING — no verdict moves, nothing is recorded, analyzed_at
// is untouched. Reuses the ONE shared comparison the Rust analyzer uses, so the
// two can never disagree. Checks NAMES only (presence + unknown keys); it does
// not type-check values, and the verdict is a schema-snapshot, not a guarantee.
export function checkWrite(
  table: string,
  fields: string[],
  verb: CheckWriteVerb,
  graph: Graph,
): CheckWriteResult {
  const contract = contractNode(graph, table);
  if (!contract) {
    // Unknown table → say so, NO fabricated verdict.
    return {
      table,
      found: false,
      verb,
      missingRequired: [],
      unknownKeys: [],
      checkedAgainst: [],
      scope: 'column-level · schema-snapshot',
      analyzed_at: graph.generatedAt,
      note: `\`${table}\` is not a scanned contract in this graph — no verdict. ${CHECK_WRITE_CAVEAT}`,
    };
  }

  const columns = contract.columns ?? [];
  const cmp = compareWriteFields(fields, verb, columns);
  return {
    table,
    found: true,
    verb,
    verdict: cmp.schemaMatch === 'aligned' ? 'would_align' : 'would_mismatch',
    missingRequired: cmp.missingRequired,
    unknownKeys: cmp.unknownKeys,
    checkedAgainst: columns.map((c) => c.name),
    scope: 'column-level · schema-snapshot',
    analyzed_at: graph.generatedAt,
    note: CHECK_WRITE_CAVEAT,
  };
}
