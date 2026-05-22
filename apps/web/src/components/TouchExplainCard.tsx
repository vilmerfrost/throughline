import type { GraphNode } from '@throughline/core';
import { effectiveVerdict, langTag, toneOf, toneVar } from '../lib/trust';
import { SourceLink } from './SourceLink';

// One individual touch inside an aggregate's drill-down. Shows the grounded
// facts (label, file:line, snippet) and reuses the working /explain endpoint —
// each card owns its own explain state so they expand independently.
export function TouchExplainCard({ node }: { node: GraphNode }) {
  const verdict = effectiveVerdict(node);
  const color = toneVar(toneOf(node.kind, verdict));

  return (
    <li className="rounded-md border border-neutral-800 p-3">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
        {node.language ? (
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-neutral-300">
            {langTag(node.language)}
          </span>
        ) : null}
        {verdict ? (
          <span className="text-[11px] uppercase tracking-wide text-neutral-400">{verdict}</span>
        ) : null}
      </div>

      <div className="mt-1 break-words font-mono text-sm text-neutral-100">{node.label}</div>

      {node.source ? (
        <>
          <div className="mt-1 font-mono text-[11px] text-neutral-500">
            <SourceLink source={node.source}>
              {node.source.filePath}:{node.source.startLine}
              {node.source.endLine !== node.source.startLine ? `-${node.source.endLine}` : ''}
            </SourceLink>
          </div>
          <pre className="mt-2 overflow-x-auto rounded border border-neutral-800 bg-black/60 p-2 font-mono text-[11px] leading-relaxed text-neutral-300">
            {node.source.snippet}
          </pre>
        </>
      ) : null}

    </li>
  );
}
