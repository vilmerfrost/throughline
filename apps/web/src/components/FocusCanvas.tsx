import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  useNodesState,
  useReactFlow,
  type Edge,
  type EdgeMouseHandler,
  type Node,
  type NodeMouseHandler,
} from '@xyflow/react';
import type { FocusAggregate, FocusModel } from '../lib/focus';
import { verdictRank } from '../lib/focus';
import { edgeLabel, toneVar, verdictCopy, type Verdict } from '../lib/trust';
import { AggregateNode } from './AggregateNode';
import { ContractSpineNode } from './ContractSpineNode';

const nodeTypes = { aggregate: AggregateNode, spine: ContractSpineNode };

// Fixed three-lane geometry — the structure is always Writers | Contract |
// Readers left-to-right, so we place lanes by hand (no Dagre needed). Each lane
// stacks vertically and is centered against the tallest lane. Spacing is tight
// enough to fit a typical writers/readers count without fitView shrinking
// nodes to dots, but loose enough that mid-edge labels don't crowd the spine.
const LANE_GAP = 120;
const SPINE_H = 150; // the (taller) contract node — used only for centering
const LANE_A_X = 0; // writers
const LANE_B_X = 400; // contract spine — 180px gap past writer node (220 wide)
const LANE_C_X = 780; // readers — 100px gap past contract node (280 wide)
const ANIMATE_MAX_EDGES = 120;

// SVG label styling — a small mid-edge chip in the edge's own color so each
// connection is self-describing. React Flow places it at the edge midpoint.
const LABEL_BG_STYLE = {
  fill: 'var(--color-bg-surface)',
  stroke: 'var(--color-border-subtle)',
  fillOpacity: 0.92,
} as const;
function labelStyle(color: string) {
  return { fill: color, fontSize: 11, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' };
}

interface FocusCanvasProps {
  model: FocusModel;
  live: boolean;
  selectedId: string | null; // a real node (the contract) is inspected
  selectedAggKey: string | null; // an aggregate is inspected
  onSelectNode: (id: string) => void;
  onSelectAggregate: (agg: FocusAggregate) => void;
  onClear: () => void;
}

type Tip = { verdict: Verdict; x: number; y: number };

// Hover tooltip — meaning + what-breaks for a verdict. Fixed-positioned at the
// cursor, pointer-events-none (never blocks node clicks), and flips near the
// viewport edges so it can't get clipped.
function TrustTooltip({ verdict, x, y }: Tip) {
  const copy = verdictCopy(verdict);
  const color = toneVar(verdict);
  const W = 288;
  const H = 132;
  const left = x + 16 + W > window.innerWidth ? x - W - 16 : x + 16;
  const top = y + 16 + H > window.innerHeight ? y - H - 16 : y + 16;
  return (
    <div
      className="pointer-events-none fixed z-50 w-72 rounded-md border bg-popover p-3 text-xs shadow-elev2"
      style={{ left, top, borderColor: 'var(--color-border-subtle)' }}
    >
      <div className="mb-1.5 flex items-baseline gap-1.5">
        <span className="font-semibold" style={{ color }}>
          {copy.plain}
        </span>
        <span className="text-[11px] text-neutral-500">{verdict}</span>
      </div>
      <p className="leading-relaxed text-neutral-200">{copy.meaning}</p>
      <p className="mt-1.5 leading-relaxed text-neutral-400">{copy.risk}</p>
    </div>
  );
}

export function FocusCanvas({
  model,
  live,
  selectedId,
  selectedAggKey,
  onSelectNode,
  onSelectAggregate,
  onClear,
}: FocusCanvasProps) {
  const { nodes: baseNodes, edges: baseEdges } = useMemo(() => {
    const { writers, readers, contract } = model;
    const rows = Math.max(writers.length, readers.length, 1);
    const totalH = rows * LANE_GAP;
    const writersOffset = (totalH - writers.length * LANE_GAP) / 2;
    const readersOffset = (totalH - readers.length * LANE_GAP) / 2;
    const spineY = totalH / 2 - SPINE_H / 2;

    const nodes: Node[] = [];

    writers.forEach((w, i) => {
      nodes.push({
        id: `agg:${w.key}`,
        type: 'aggregate',
        position: { x: LANE_A_X, y: writersOffset + i * LANE_GAP },
        data: { language: w.language, direction: w.direction, verdict: w.verdict, count: w.count },
      });
    });

    const usage = contract.columnUsage ?? [];
    // Worst verdict among the contract's touches drives the spine's emphasis —
    // a contract sitting on a mismatch/dark touch reads more prominently than
    // one whose worst touch is verified.
    let worst: Verdict | null = null;
    for (const a of [...writers, ...readers]) {
      if (worst === null || verdictRank(a.verdict) < verdictRank(worst)) worst = a.verdict;
    }
    nodes.push({
      id: contract.id,
      type: 'spine',
      position: { x: LANE_B_X, y: spineY },
      data: {
        label: contract.label,
        columnCount: contract.columns?.length ?? 0,
        neverReadCount: usage.filter((u) => u.reach === 'never_read').length,
        serverOnlyCount: usage.filter((u) => u.reach === 'server_only').length,
        writtenNothingReads: model.flags.writtenNothingReads,
        readNothingWrites: model.flags.readNothingWrites,
        worstVerdict: worst,
      },
    });

    readers.forEach((r, i) => {
      nodes.push({
        id: `agg:${r.key}`,
        type: 'aggregate',
        position: { x: LANE_C_X, y: readersOffset + i * LANE_GAP },
        data: { language: r.language, direction: r.direction, verdict: r.verdict, count: r.count },
      });
    });

    const writeColor = 'var(--color-edge-write)';
    const readColor = 'var(--color-edge-read)';
    const edges: Edge[] = [];

    // Write edges flow Lane A -> Lane B (writer into the contract). Label is a
    // short plain phrase ("writes blind"); full meaning + risk live in hover.
    writers.forEach((w) => {
      edges.push({
        id: `we:${w.key}`,
        source: `agg:${w.key}`,
        target: contract.id,
        sourceHandle: 'sr',
        targetHandle: 'tl',
        data: { verdict: w.verdict },
        style: { stroke: writeColor, strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: writeColor },
        label: edgeLabel(w.direction, w.verdict),
        labelStyle: labelStyle(writeColor),
        labelBgStyle: LABEL_BG_STYLE,
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 4,
      });
    });
    // Read edges flow Lane B -> Lane C (contract out to the reader).
    readers.forEach((r) => {
      edges.push({
        id: `re:${r.key}`,
        source: contract.id,
        target: `agg:${r.key}`,
        sourceHandle: 'sr',
        targetHandle: 'tl',
        data: { verdict: r.verdict },
        style: { stroke: readColor, strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: readColor },
        label: edgeLabel(r.direction, r.verdict),
        labelStyle: labelStyle(readColor),
        labelBgStyle: LABEL_BG_STYLE,
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 4,
      });
    });

    return { nodes, edges };
  }, [model]);

  // Nodes live in RF state so they can be freely dragged. Positions reset when a
  // new contract is selected (baseNodes changes) — drag state needn't persist.
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState(baseNodes);
  useEffect(() => setRfNodes(baseNodes), [baseNodes, setRfNodes]);

  const animate = live && baseEdges.length <= ANIMATE_MAX_EDGES;

  // Overlay external selection each render without disturbing dragged positions.
  const nodes = useMemo(
    () =>
      rfNodes.map((n) => ({
        ...n,
        selected: n.id === selectedId || n.id === `agg:${selectedAggKey}`,
      })),
    [rfNodes, selectedId, selectedAggKey],
  );

  const edges = useMemo(
    () => baseEdges.map((e) => ({ ...e, animated: animate })),
    [baseEdges, animate],
  );

  // Refit whenever the selected contract changes so its flow fills the canvas.
  // minZoom keeps tall/narrow canvases from shrinking nodes to illegible dots —
  // the user can pan to see overflow. maxZoom stops a small flow from blowing
  // up to a single chip filling the canvas.
  const rf = useReactFlow();
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      rf.fitView({ padding: 0.2, duration: 0, minZoom: 0.6, maxZoom: 1 }),
    );
    return () => cancelAnimationFrame(id);
  }, [model.contract.id, rf]);

  const handleNodeClick: NodeMouseHandler = (_e, node) => {
    if (node.type === 'aggregate') {
      const key = node.id.slice('agg:'.length);
      const agg = [...model.writers, ...model.readers].find((a) => a.key === key);
      if (agg) onSelectAggregate(agg);
    } else {
      onSelectNode(node.id);
    }
  };

  // --- Hover tooltips (touch nodes + edges) ---
  const [tip, setTip] = useState<Tip | null>(null);
  const verdictOf = (data: unknown): Verdict | undefined =>
    (data as { verdict?: Verdict } | undefined)?.verdict;

  const showNodeTip: NodeMouseHandler = (e, node) => {
    const verdict = verdictOf(node.data);
    if (node.type === 'aggregate' && verdict) setTip({ verdict, x: e.clientX, y: e.clientY });
  };
  const showEdgeTip: EdgeMouseHandler = (e, edge) => {
    const verdict = verdictOf(edge.data);
    if (verdict) setTip({ verdict, x: e.clientX, y: e.clientY });
  };
  const clearTip = () => setTip(null);

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={handleNodeClick}
        onNodeMouseEnter={showNodeTip}
        onNodeMouseMove={showNodeTip}
        onNodeMouseLeave={clearTip}
        onNodeDragStart={clearTip}
        onEdgeMouseEnter={showEdgeTip}
        onEdgeMouseMove={showEdgeTip}
        onEdgeMouseLeave={clearTip}
        onPaneClick={onClear}
        nodesDraggable
        nodesConnectable={false}
        minZoom={0.1}
        fitView
        fitViewOptions={{ padding: 0.2, duration: 0, minZoom: 0.6, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--color-grid)" gap={20} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {tip ? <TrustTooltip {...tip} /> : null}
    </div>
  );
}
