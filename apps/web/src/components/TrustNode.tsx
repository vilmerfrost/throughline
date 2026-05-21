import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeKind, Trust } from '@throughline/core';
import { langTag, toneBorderClass, toneDotClass, toneOf, toneVar } from '../lib/trust';

export interface TrustNodeData extends Record<string, unknown> {
  label: string;
  kind: NodeKind;
  trust?: Trust;
  language?: string;
  columnCount?: number;
  filePath?: string;
}

// §5A — fixed-width card; trust communicated via border + dot (no loud fills).
// Header text and metadata are `lod-hideable` so they drop out when zoomed out.
function TrustNodeBase({ data, selected }: NodeProps) {
  const d = data as TrustNodeData;
  const tone = toneOf(d.kind, d.trust);
  const color = toneVar(tone);
  const rightMeta =
    d.kind === 'contract' ? `sql · ${d.columnCount ?? 0} cols` : langTag(d.language);

  return (
    <div
      className={`w-[220px] rounded-md border ${toneBorderClass(tone)} bg-node px-3 py-2 text-left backdrop-blur-sm`}
      style={selected ? { boxShadow: `0 0 0 2px ${color}` } : undefined}
    >
      {/* Handles: hidden until a connection is dragged, color-matched to border. */}
      <Handle type="target" position={Position.Left} id="tl" className="opacity-0" style={{ background: color }} />
      <Handle type="source" position={Position.Left} id="sl" className="opacity-0" style={{ background: color }} />
      <Handle type="target" position={Position.Right} id="tr" className="opacity-0" style={{ background: color }} />
      <Handle type="source" position={Position.Right} id="sr" className="opacity-0" style={{ background: color }} />

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${toneDotClass(tone)}`} />
          <span className="lod-hideable text-[11px] font-medium uppercase tracking-wide text-neutral-400">
            {d.kind}
          </span>
        </div>
        {rightMeta ? (
          <span className="lod-hideable shrink-0 text-[11px] uppercase tracking-wide text-neutral-500">
            {rightMeta}
          </span>
        ) : null}
      </div>

      <div className="mt-1 truncate font-mono text-sm text-neutral-100">{d.label}</div>

      {d.filePath ? (
        <div className="lod-hideable mt-0.5 truncate font-mono text-[11px] text-neutral-500">
          {d.filePath}
        </div>
      ) : null}
    </div>
  );
}

// §7 — memoized so selection/hover changes elsewhere don't re-render every node.
export const TrustNode = memo(TrustNodeBase);
