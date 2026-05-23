import type { NeighborEdge, RelationshipNeighborhood } from '../lib/relationships';

// FK-A2: the selected contract's foreign-key NEIGHBORHOOD, rendered as a band
// beneath the focus canvas — deliberately separate from the writers→contract→
// readers data-touch flow because table↔table FKs are a different kind of edge.
// Two horizontally-scrolling tracks keep a high-degree table (e.g. profiles,
// referenced by dozens) from ever becoming a vertical hairball. Clicking a
// scanned-contract neighbor navigates to its focus view; external targets
// (auth.users) are shown but not navigable, and an island says so plainly.

interface Props {
  neighborhood: RelationshipNeighborhood;
  onSelectContract: (contractId: string) => void;
}

const CARDINALITY_LABEL: Record<NeighborEdge['cardinality'], string> = {
  'many-to-one': 'many-to-one',
  'one-to-one': 'one-to-one',
};

export function RelationshipBand({ neighborhood, onSelectContract }: Props) {
  const { references, referencedBy, isIsland, contractLabel } = neighborhood;

  return (
    <section
      aria-label={`Foreign-key relationships for ${contractLabel}`}
      className="shrink-0 border-t border-neutral-800 bg-neutral-900"
    >
      <div className="flex items-center gap-2 px-4 pt-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-600">
        foreign-key relationships
        <span className="font-normal lowercase tracking-normal text-neutral-600">
          · table ↔ table, not data touches
        </span>
      </div>

      {isIsland ? (
        <p className="px-4 py-3 text-xs text-neutral-500">
          No foreign-key relationships — <span className="text-neutral-400">{contractLabel}</span>{' '}
          neither references another table nor is referenced by one.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5 px-4 pb-2.5 pt-1.5">
          <Track
            label="references"
            arrow="→"
            edges={references}
            emptyHint="references no other table"
            onSelectContract={onSelectContract}
          />
          <Track
            label="referenced by"
            arrow="←"
            arrowLeading
            edges={referencedBy}
            emptyHint="not referenced by any table"
            onSelectContract={onSelectContract}
          />
        </div>
      )}
    </section>
  );
}

interface TrackProps {
  label: string;
  arrow: string;
  arrowLeading?: boolean;
  edges: NeighborEdge[];
  emptyHint: string;
  onSelectContract: (contractId: string) => void;
}

function Track({ label, arrow, arrowLeading, edges, emptyHint, onSelectContract }: TrackProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex w-32 shrink-0 items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {arrowLeading && <span className="text-neutral-600">{arrow}</span>}
        {label}
        {!arrowLeading && <span className="text-neutral-600">{arrow}</span>}
        <span className="text-neutral-600">({edges.length})</span>
      </span>
      <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-0.5">
        {edges.length === 0 ? (
          <span className="py-1 text-[11px] italic text-neutral-600">{emptyHint}</span>
        ) : (
          edges.map((e, i) => (
            <EdgeChip key={`${e.relationship.fromTable}.${e.fromColumn}->${e.relationship.toTable}.${e.toColumn}#${i}`} edge={e} onSelectContract={onSelectContract} />
          ))
        )}
      </div>
    </div>
  );
}

function EdgeChip({
  edge,
  onSelectContract,
}: {
  edge: NeighborEdge;
  onSelectContract: (contractId: string) => void;
}) {
  const meta = (
    <span className="mt-0.5 block whitespace-nowrap font-mono text-[10px] text-neutral-500">
      {edge.fromColumn} → {edge.toColumn} · {CARDINALITY_LABEL[edge.cardinality]}
    </span>
  );

  // External target (e.g. auth.users): real, declared, but NOT one of our
  // contracts — shown as a distinct, non-navigable node, never a dangling edge.
  if (edge.external) {
    return (
      <span
        title={`External target — ${edge.neighborLabel} is not a scanned contract`}
        className="shrink-0 rounded-md border border-dashed border-neutral-700 bg-transparent px-2.5 py-1 text-left"
      >
        <span className="flex items-center gap-1.5 whitespace-nowrap text-xs">
          <span className="text-[9px] font-semibold uppercase tracking-wider text-neutral-600">
            external
          </span>
          <span className="font-mono text-neutral-400">{edge.neighborLabel}</span>
        </span>
        {meta}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => edge.neighborContractId && onSelectContract(edge.neighborContractId)}
      title={`Open ${edge.neighborLabel} in focus view`}
      className="group shrink-0 rounded-md border border-neutral-700 bg-node px-2.5 py-1 text-left backdrop-blur-sm transition hover:border-trust-contract focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-trust-contract"
    >
      <span className="flex items-center gap-1.5 whitespace-nowrap text-xs">
        <span className="h-2 w-2 shrink-0 rounded-[2px] border border-trust-contract" />
        <span className="font-mono text-neutral-200 group-hover:text-neutral-50">
          {edge.neighborLabel}
        </span>
        {edge.selfRef && (
          <span className="text-[9px] font-semibold uppercase tracking-wider text-neutral-600">
            self
          </span>
        )}
      </span>
      {meta}
    </button>
  );
}
