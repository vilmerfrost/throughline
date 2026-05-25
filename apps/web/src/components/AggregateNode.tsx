import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Braces,
  Code,
  Database,
  FileCode,
  FileJson,
  type LucideIcon,
} from 'lucide-react';
import type { EdgeDirection, Language } from '@throughline/core';
import {
  langName,
  toneBorderClass,
  toneDotClass,
  toneVar,
  verdictCopy,
  verdictWeight,
  type Verdict,
  type Weight,
} from '../lib/trust';

// Lucide icon per language — a small visual cue so the eye can tell a Rust
// write from a TypeScript read without reading the label. Purely decorative
// (the text label remains authoritative).
const LANG_ICON: Record<Language, LucideIcon> = {
  rust: Braces,
  typescript: FileCode,
  python: Code,
  sql: Database,
  json: FileJson,
};

// Direction icon: writes push data up/into the spine, reads pull it down/out.
const DIRECTION_ICON: Record<EdgeDirection, LucideIcon> = {
  write: ArrowUpFromLine,
  read: ArrowDownToLine,
};

// One lane node = all touches sharing (language x verdict x direction), e.g.
// "RUST write ×3" colored teal (aligned). Mirrors TrustNode's card styling (§5A):
// fixed width, border + dot carry the verdict color, no loud fills.
//
// Hierarchy: the worst verdict in the view gets more visual weight — a thicker
// border + a soft halo for `critical` (mismatch), a quieter card for `quiet`
// (verified). The colors' meaning is unchanged; only the pixel-weight shifts so
// the problem lands on the eye first.
export interface AggregateNodeData extends Record<string, unknown> {
  language: Language;
  direction: EdgeDirection;
  verdict: Verdict;
  count: number;
}

function weightStyles(weight: Weight, color: string): {
  borderWidth: number;
  dotPx: number;
  textTone: string;
  glowShadow: string | undefined;
  opacity: number;
} {
  switch (weight) {
    case 'critical':
      return {
        borderWidth: 2,
        dotPx: 12,
        textTone: 'text-neutral-50',
        // Soft halo in the verdict color so mismatch lifts off the canvas.
        glowShadow: `0 0 0 1px ${color}, 0 0 18px -2px ${color}`,
        opacity: 1,
      };
    case 'attention':
      return {
        borderWidth: 1.5,
        dotPx: 11,
        textTone: 'text-neutral-100',
        glowShadow: undefined,
        opacity: 1,
      };
    case 'okay':
      return {
        borderWidth: 1,
        dotPx: 10,
        textTone: 'text-neutral-200',
        glowShadow: undefined,
        opacity: 0.95,
      };
    case 'quiet':
      return {
        borderWidth: 1,
        dotPx: 9,
        textTone: 'text-neutral-300',
        glowShadow: undefined,
        opacity: 0.78,
      };
  }
}

function AggregateNodeBase({ data, selected }: NodeProps) {
  const d = data as AggregateNodeData;
  const color = toneVar(d.verdict);
  const weight = verdictWeight(d.verdict);
  const w = weightStyles(weight, color);
  const LangIcon = LANG_ICON[d.language];
  const DirIcon = DIRECTION_ICON[d.direction];

  // Base elevation always present (the card floats); selection ring and the
  // critical glow stack on top of it.
  const cardStyle: React.CSSProperties = {
    borderWidth: w.borderWidth,
    boxShadow: [
      selected ? `0 0 0 2px ${color}` : null,
      w.glowShadow,
      'var(--elev-1)',
    ]
      .filter(Boolean)
      .join(', '),
    opacity: w.opacity,
  };

  return (
    <div
      className={`w-[220px] rounded-md border ${toneBorderClass(d.verdict)} bg-node px-3 py-2 text-left backdrop-blur-sm`}
      style={cardStyle}
    >
      {/* Writers expose a source on the right (into the spine); readers a target
          on the left (out of the spine). We register both, hidden, like §5A. */}
      <Handle type="target" position={Position.Left} id="tl" className="opacity-0" style={{ background: color }} />
      <Handle type="source" position={Position.Right} id="sr" className="opacity-0" style={{ background: color }} />

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={`shrink-0 rounded-full ${toneDotClass(d.verdict)}`}
            style={{ width: w.dotPx, height: w.dotPx }}
          />
          <LangIcon className="shrink-0 text-neutral-400" size={13} strokeWidth={1.75} aria-hidden />
          <span className="lod-hideable min-w-0 truncate text-[11px] font-medium text-neutral-300">
            {langName(d.language)} {d.direction}
          </span>
          <DirIcon className="lod-hideable shrink-0 text-neutral-500" size={12} strokeWidth={1.75} aria-hidden />
        </div>
        {/* ×N = how many code touches this one node aggregates. The tooltip
            spells that out on hover so the badge isn't a mystery number. */}
        <span className="group/count relative shrink-0">
          <span className="block cursor-default rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] font-semibold text-neutral-200">
            ×{d.count}
          </span>
          <span
            role="tooltip"
            className="pointer-events-none absolute bottom-full right-0 z-50 mb-1.5 hidden w-52 rounded-md border border-neutral-700 bg-popover p-2 text-left text-[11px] font-normal normal-case leading-snug text-neutral-300 shadow-[var(--elev-2)] group-hover/count:block"
          >
            <span className="font-mono font-semibold text-neutral-100">×{d.count}</span> — {d.count} code{' '}
            {d.count === 1 ? 'location' : 'locations'} of the same language, direction &amp; verdict aggregated
            here. Click to expand each touch.
          </span>
        </span>
      </div>

      {/* Primary: plain phrase. Secondary: the original jargon word, muted. */}
      <div className={`mt-1 truncate font-mono text-sm ${w.textTone}`}>
        {verdictCopy(d.verdict).plain}
      </div>
      <div className="lod-hideable mt-0.5 text-[11px] text-neutral-500">{d.verdict}</div>
    </div>
  );
}

export const AggregateNode = memo(AggregateNodeBase);
