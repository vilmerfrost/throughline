import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { toneDotClass, toneVar, verdictWeight, type Verdict } from '../lib/trust';

// The center of the focus view: the contract itself. SHAPE carries kind here —
// a contract is a TABLE (source of truth), a different *kind* of thing from a
// touch, not a point on the trust color scale. So it gets a double border
// (outer ring + inner frame) and a "TABLE" header band, and is wider than the
// thin single-border touch chips. Color still = the contract spine token.
//
// When the contract's worst touch verdict is critical (mismatch), the spine
// picks up a soft halo in that verdict's color — so a contract sitting on a
// mismatch is impossible to miss. Color meanings are unchanged; only weight.
export interface ContractSpineNodeData extends Record<string, unknown> {
  label: string;
  columnCount: number;
  // The "stored but not shown" reach signal: columns with no TS reader, and
  // columns used server-side but never rendered.
  neverReadCount: number; // reach === 'never_read'
  serverOnlyCount: number; // reach === 'server_only'
  writtenNothingReads: boolean;
  readNothingWrites: boolean;
  worstVerdict?: Verdict | null;
}

function ContractSpineNodeBase({ data, selected }: NodeProps) {
  const d = data as ContractSpineNodeData;
  const color = toneVar('contract');
  const weight = verdictWeight(d.worstVerdict ?? null);
  const worstColor = d.worstVerdict ? toneVar(d.worstVerdict) : null;

  // Halo only fires for `critical` (mismatch) — it's intentionally rare so it
  // stays meaningful. `attention` keeps a clean spine; the user spots it via
  // the connected dark/asserted aggregate nodes flanking it.
  const haloShadow =
    weight === 'critical' && worstColor
      ? `0 0 0 1px ${worstColor}, 0 0 22px -4px ${worstColor}`
      : undefined;

  // Base elevation always present (the table card floats above the canvas); the
  // selection ring and the critical mismatch halo stack on top of it.
  const composedShadow = [
    selected ? `0 0 0 3px ${color}` : null,
    haloShadow,
    'var(--elev-1)',
  ]
    .filter(Boolean)
    .join(', ');

  return (
    // Outer ring — the `p-1` gap between this border and the inner frame is what
    // reads as a double border (a table frame), distinct from touch chips.
    <div
      className="w-[280px] rounded-lg border-2 border-trust-contract bg-node p-1 backdrop-blur"
      style={{ boxShadow: composedShadow }}
    >
      <div className="overflow-hidden rounded-md border border-trust-contract">
        {/* Header band — the structural "this is a container" cue. */}
        <div className="flex items-center justify-between border-b border-trust-contract bg-neutral-800/50 px-3 py-1.5">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${toneDotClass('contract')}`} />
            <span
              className="lod-hideable text-[10px] font-semibold uppercase tracking-widest"
              style={{ color }}
            >
              Table
            </span>
          </div>
          <span className="lod-hideable text-[10px] uppercase tracking-wide text-neutral-500">sql</span>
        </div>

        {/* Body — the table name + column count, plus any leftover flags. */}
        <div className="px-4 py-3">
          <div className="truncate font-mono text-base text-neutral-100">{d.label}</div>
          <div className="lod-hideable mt-0.5 text-[11px] text-neutral-500">
            {d.columnCount} columns
            {d.neverReadCount > 0 ? (
              <span style={{ color: 'var(--color-narrowed)' }}> · {d.neverReadCount} no reader</span>
            ) : null}
            {d.serverOnlyCount > 0 ? (
              <span style={{ color: 'var(--color-edge-read)' }}> · {d.serverOnlyCount} not shown</span>
            ) : null}
          </div>

          {/* Critical-verdict banner — surfaces the mismatch without changing
              the table's own (contract) tone. Drops below the column line so
              the table identity stays the first thing read. */}
          {weight === 'critical' && worstColor ? (
            <div
              className="lod-hideable mt-2 flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wide"
              style={{
                color: worstColor,
                background: `color-mix(in oklab, ${worstColor} 14%, transparent)`,
                borderTop: `1px solid color-mix(in oklab, ${worstColor} 40%, transparent)`,
              }}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: worstColor }} />
              schema mismatch on a touch
            </div>
          ) : null}

          {d.writtenNothingReads || d.readNothingWrites ? (
            <div className="lod-hideable mt-2 space-y-1">
              {d.writtenNothingReads ? (
                <div
                  className="rounded border px-2 py-1 text-[11px]"
                  style={{ borderColor: 'var(--color-narrowed)', color: 'var(--color-narrowed)' }}
                >
                  enters, nothing reads it
                </div>
              ) : null}
              {d.readNothingWrites ? (
                <div
                  className="rounded border px-2 py-1 text-[11px]"
                  style={{ borderColor: 'var(--color-narrowed)', color: 'var(--color-narrowed)' }}
                >
                  read, nothing writes it here
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <Handle type="target" position={Position.Left} id="tl" className="opacity-0" style={{ background: color }} />
      <Handle type="source" position={Position.Right} id="sr" className="opacity-0" style={{ background: color }} />
    </div>
  );
}

export const ContractSpineNode = memo(ContractSpineNodeBase);
