import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { EdgeDirection, Language, Trust } from '@throughline/core';
import { TRUST_COPY, langTag, toneBorderClass, toneDotClass, toneVar } from '../lib/trust';

// One lane node = all touches sharing (language x trust x direction), e.g.
// "RUST write ×4" colored dark. Mirrors TrustNode's card styling (§5A): fixed
// width, border + dot carry the trust color, no loud fills.
export interface AggregateNodeData extends Record<string, unknown> {
  language: Language;
  direction: EdgeDirection;
  trust: Trust;
  count: number;
}

function AggregateNodeBase({ data, selected }: NodeProps) {
  const d = data as AggregateNodeData;
  const color = toneVar(d.trust);

  return (
    <div
      className={`w-[220px] rounded-md border ${toneBorderClass(d.trust)} bg-node px-3 py-2 text-left backdrop-blur-sm`}
      style={selected ? { boxShadow: `0 0 0 2px ${color}` } : undefined}
    >
      {/* Writers expose a source on the right (into the spine); readers a target
          on the left (out of the spine). We register both, hidden, like §5A. */}
      <Handle type="target" position={Position.Left} id="tl" className="opacity-0" style={{ background: color }} />
      <Handle type="source" position={Position.Right} id="sr" className="opacity-0" style={{ background: color }} />

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${toneDotClass(d.trust)}`} />
          <span className="lod-hideable text-[11px] font-medium uppercase tracking-wide text-neutral-400">
            {langTag(d.language)} {d.direction}
          </span>
        </div>
        <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] font-semibold text-neutral-200">
          ×{d.count}
        </span>
      </div>

      {/* Primary: plain phrase. Secondary: the original jargon word, muted. */}
      <div className="mt-1 truncate font-mono text-sm text-neutral-100">{TRUST_COPY[d.trust].plain}</div>
      <div className="lod-hideable mt-0.5 text-[11px] text-neutral-500">{d.trust}</div>
    </div>
  );
}

export const AggregateNode = memo(AggregateNodeBase);
