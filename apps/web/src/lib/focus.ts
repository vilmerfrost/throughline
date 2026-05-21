import type {
  DriftFinding,
  EdgeDirection,
  Graph,
  GraphNode,
  Language,
  Trust,
} from '@throughline/core';

// The focus view is contract-centric: pick one contract and see its real data
// flow as Writers -> Contract -> Readers. Everything here is derived from the
// SAME graph the rest of the app uses — edges are always (source = touch id,
// target = contract id, direction), so a contract's touches are the edges whose
// target is that contract, joined back to their source touch node.
//
// HONESTY: counts are the real number of touches; aggregates group the actual
// touch nodes (never invented). Lane C is "reads" — we detect reads, not UI
// rendering.

export interface FocusAggregate {
  key: string; // `${direction}:${language}:${trust}` — stable id for selection
  direction: EdgeDirection;
  language: Language;
  trust: Trust;
  count: number;
  touchIds: string[]; // the individual touch node ids this aggregate rolls up
}

export interface ContractSummary {
  id: string;
  label: string;
  columnCount: number;
  writeCount: number;
  readCount: number;
  trust: Trust | null; // worst trust among ALL touches; null = no touches (untouched)
}

export interface FocusModel {
  contract: GraphNode;
  writers: FocusAggregate[]; // direction === 'write'
  readers: FocusAggregate[]; // direction === 'read'
  writeCount: number;
  readCount: number;
  flags: {
    // Driven by the real touch counts (and mirror the analyzer's asymmetry drift).
    writtenNothingReads: boolean; // written but no detected reader
    readNothingWrites: boolean; // read but no detected writer
  };
  drift: DriftFinding[];
}

// Worst trust wins: dark (blind) > asserted > narrowed > verified. Lower rank =
// more blind, so it floats to the top of the list; an untouched contract (null,
// no touches at all) sinks last — never confused with all-verified green.
const TRUST_RANK: Record<Trust, number> = { dark: 0, asserted: 1, narrowed: 2, verified: 3 };
export function trustRank(trust: Trust | null): number {
  return trust === null ? 4 : TRUST_RANK[trust];
}

interface JoinedTouch {
  node: GraphNode;
  direction: EdgeDirection;
}

// Every touch on a contract: edges targeting it, joined to their source node.
function touchesFor(graph: Graph, contractId: string): JoinedTouch[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: JoinedTouch[] = [];
  for (const e of graph.edges) {
    if (e.target !== contractId) continue;
    const node = byId.get(e.source);
    if (node) out.push({ node, direction: e.direction });
  }
  return out;
}

// Worst (most-blind) trust among a contract's touches. null = no touches at all.
// Only touches carrying a trust count — same honesty rule as aggregate().
function worstTrust(touches: JoinedTouch[]): Trust | null {
  let worst: Trust | null = null;
  for (const { node } of touches) {
    const t = node.trust;
    if (!t) continue;
    if (worst === null || TRUST_RANK[t] < TRUST_RANK[worst]) worst = t;
  }
  return worst;
}

// Roll touches up by (direction x language x trust). Aggregates are sorted by
// count desc (then language) so the heaviest flows read first.
function aggregate(touches: JoinedTouch[], direction: EdgeDirection): FocusAggregate[] {
  const byKey = new Map<string, FocusAggregate>();
  for (const { node, direction: dir } of touches) {
    if (dir !== direction) continue;
    if (!node.language || !node.trust) continue; // keep counts honest, never guess
    const key = `${dir}:${node.language}:${node.trust}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      existing.touchIds.push(node.id);
    } else {
      byKey.set(key, {
        key,
        direction: dir,
        language: node.language,
        trust: node.trust,
        count: 1,
        touchIds: [node.id],
      });
    }
  }
  return [...byKey.values()].sort(
    (a, b) => b.count - a.count || a.language.localeCompare(b.language),
  );
}

// All contracts with their counts + worst touch trust, sorted most-blind first
// (dark -> asserted -> narrowed -> verified -> untouched), then alphabetically.
// Drives the left-rail picker dot + order so the two always agree.
export function buildContractSummaries(graph: Graph): ContractSummary[] {
  const summaries = graph.nodes
    .filter((n) => n.kind === 'contract')
    .map((c) => {
      const touches = touchesFor(graph, c.id);
      const writeCount = touches.filter((t) => t.direction === 'write').length;
      const readCount = touches.filter((t) => t.direction === 'read').length;
      return {
        id: c.id,
        label: c.label,
        columnCount: c.columns?.length ?? 0,
        writeCount,
        readCount,
        trust: worstTrust(touches),
      };
    });

  return summaries.sort(
    (a, b) => trustRank(a.trust) - trustRank(b.trust) || a.label.localeCompare(b.label),
  );
}

// The full focus model for one contract: the two lanes of aggregates, counts,
// leftover flags, and the drift findings targeting it.
export function buildFocusModel(graph: Graph, contractId: string): FocusModel | null {
  const contract = graph.nodes.find((n) => n.id === contractId && n.kind === 'contract');
  if (!contract) return null;

  const touches = touchesFor(graph, contractId);
  const writers = aggregate(touches, 'write');
  const readers = aggregate(touches, 'read');
  const writeCount = writers.reduce((sum, a) => sum + a.count, 0);
  const readCount = readers.reduce((sum, a) => sum + a.count, 0);

  return {
    contract,
    writers,
    readers,
    writeCount,
    readCount,
    flags: {
      writtenNothingReads: writeCount > 0 && readCount === 0,
      readNothingWrites: readCount > 0 && writeCount === 0,
    },
    drift: graph.drift.filter((d) => d.contractId === contractId),
  };
}
