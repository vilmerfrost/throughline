import type {
  DriftFinding,
  EdgeDirection,
  Graph,
  GraphNode,
  Language,
} from '@throughline/core';
import { effectiveVerdict, type Verdict } from './trust';
import { summarizeReach, type ReachSummary } from './columnUsage';

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
  key: string; // `${direction}:${language}:${verdict}` — stable id for selection
  direction: EdgeDirection;
  language: Language;
  verdict: Verdict; // effective verdict (schemaMatch overrides trust on deep-parsed writes)
  count: number;
  touchIds: string[]; // the individual touch node ids this aggregate rolls up
}

export interface ContractSummary {
  id: string;
  label: string;
  columnCount: number;
  writeCount: number;
  readCount: number;
  verdict: Verdict | null; // worst effective verdict among ALL touches; null = untouched
  reach: ReachSummary; // per-reach column counts — drives the "columns present" filter
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

// Worst verdict wins, worst → best: mismatch > dark > asserted > narrowed >
// aligned > verified. Lower rank = worse, so it floats to the top of the list;
// an untouched contract (null, no touches at all) sinks last — never confused
// with all-verified green. Note aligned ranks BELOW verified: a table whose best
// is aligned is honestly not "fully clean" (matched, but not compiler-enforced).
const VERDICT_RANK: Record<Verdict, number> = {
  mismatch: 0,
  dark: 1,
  asserted: 2,
  narrowed: 3,
  aligned: 4,
  verified: 5,
};
export function verdictRank(verdict: Verdict | null): number {
  return verdict === null ? 6 : VERDICT_RANK[verdict];
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

// Worst effective verdict among a contract's touches. null = no touches at all.
// Only touches carrying a verdict count — same honesty rule as aggregate().
function worstVerdict(touches: JoinedTouch[]): Verdict | null {
  let worst: Verdict | null = null;
  for (const { node } of touches) {
    const v = effectiveVerdict(node);
    if (!v) continue;
    if (worst === null || VERDICT_RANK[v] < VERDICT_RANK[worst]) worst = v;
  }
  return worst;
}

// Roll touches up by (direction x language x effective verdict). Grouping by the
// EFFECTIVE verdict (not raw trust) is what splits a contract's Rust writes into,
// e.g., an "aligned ×3" lane and a "dark ×1" lane. Sorted by count desc, then
// language, so the heaviest flows read first.
function aggregate(touches: JoinedTouch[], direction: EdgeDirection): FocusAggregate[] {
  const byKey = new Map<string, FocusAggregate>();
  for (const { node, direction: dir } of touches) {
    if (dir !== direction) continue;
    const verdict = effectiveVerdict(node);
    if (!node.language || !verdict) continue; // keep counts honest, never guess
    const key = `${dir}:${node.language}:${verdict}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      existing.touchIds.push(node.id);
    } else {
      byKey.set(key, {
        key,
        direction: dir,
        language: node.language,
        verdict,
        count: 1,
        touchIds: [node.id],
      });
    }
  }
  return [...byKey.values()].sort(
    (a, b) => b.count - a.count || a.language.localeCompare(b.language),
  );
}

// All contracts with their counts + worst touch verdict, sorted worst first
// (mismatch -> dark -> asserted -> narrowed -> aligned -> verified -> untouched),
// then alphabetically. Drives the left-rail picker dot + order so they agree.
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
        verdict: worstVerdict(touches),
        reach: summarizeReach(c.columnUsage ?? []),
      };
    });

  return summaries.sort(
    (a, b) => verdictRank(a.verdict) - verdictRank(b.verdict) || a.label.localeCompare(b.label),
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
