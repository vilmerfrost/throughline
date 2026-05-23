import type { Cardinality, Graph, Relationship } from '@throughline/core';

// FK-A2 view-model: a pure read over graph.relationships (produced by FK-A1).
// For ONE selected contract it builds the FK NEIGHBORHOOD — the tables it points
// to and the tables that point at it — never the whole-schema graph. It invents
// nothing: external targets (a REFERENCES whose table is not one of the scanned
// contracts, e.g. auth.users) are flagged `external` with no navigation id, and
// a contract with no FK either way is honestly an island.

export interface NeighborEdge {
  relationship: Relationship;
  neighborLabel: string; // the OTHER table in the relationship
  neighborContractId: string | null; // the node id to navigate to; null when external
  external: boolean; // true when the neighbor is not one of the scanned contracts
  selfRef: boolean; // true when the FK points the contract at itself
  fromColumn: string;
  toColumn: string;
  cardinality: Cardinality;
}

export interface RelationshipNeighborhood {
  contractLabel: string;
  references: NeighborEdge[]; // outgoing: this contract → others (its FK columns)
  referencedBy: NeighborEdge[]; // incoming: others → this contract
  isIsland: boolean; // no FK in or out
}

function byLabel(rel: NeighborEdge, b: NeighborEdge): number {
  return rel.neighborLabel.localeCompare(b.neighborLabel);
}

export function buildRelationshipNeighborhood(
  graph: Graph,
  contractId: string,
): RelationshipNeighborhood | null {
  const contract = graph.nodes.find((n) => n.id === contractId && n.kind === 'contract');
  if (!contract) return null;
  const label = contract.label;

  // label → node id, for resolving a neighbor table back to a contract we can
  // navigate to. A neighbor missing from this map is external (not scanned).
  const idByLabel = new Map<string, string>();
  for (const n of graph.nodes) {
    if (n.kind === 'contract') idByLabel.set(n.label, n.id);
  }

  const references: NeighborEdge[] = [];
  const referencedBy: NeighborEdge[] = [];

  for (const r of graph.relationships ?? []) {
    const selfRef = r.fromTable === label && r.toTable === label;
    if (r.fromTable === label) {
      // Outgoing. A self-ref is shown here only (never also under referenced-by).
      references.push(edge(r, r.toTable, idByLabel, selfRef));
    } else if (r.toTable === label) {
      referencedBy.push(edge(r, r.fromTable, idByLabel, false));
    }
  }

  references.sort(byLabel);
  referencedBy.sort(byLabel);

  return {
    contractLabel: label,
    references,
    referencedBy,
    isIsland: references.length === 0 && referencedBy.length === 0,
  };
}

function edge(
  r: Relationship,
  neighborLabel: string,
  idByLabel: Map<string, string>,
  selfRef: boolean,
): NeighborEdge {
  const neighborContractId = idByLabel.get(neighborLabel) ?? null;
  return {
    relationship: r,
    neighborLabel,
    neighborContractId,
    external: neighborContractId === null,
    selfRef,
    fromColumn: r.fromColumn,
    toColumn: r.toColumn,
    cardinality: r.cardinality,
  };
}
