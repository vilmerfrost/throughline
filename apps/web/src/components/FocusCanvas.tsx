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
import type { Trust } from '@throughline/core';
import type { FocusAggregate, FocusModel } from '../lib/focus';
import { TRUST_COPY, edgeLabel, toneVar } from '../lib/trust';
import { AggregateNode } from './AggregateNode';
import { ContractSpineNode } from './ContractSpineNode';

const nodeTypes = { aggregate: AggregateNode, spine: ContractSpineNode };

// Fixed three-lane geometry — the structure is always Writers | Contract |
// Readers left-to-right, so we place lanes by hand (no Dagre needed). Each lane
// stacks vertically and is centered against the tallest lane. Generous spacing
// so nodes and mid-edge labels breathe and don't crowd the contract.
const LANE_GAP = 140;
const SPINE_H = 150; // the (taller) contract node — used only for centering
const LANE_A_X = 0; // writers
const LANE_B_X = 460; // contract spine — widened from writers
const LANE_C_X = 900; // readers — widened from the contract
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

type Tip = { trust: Trust; x: number; y: number };

// Hover tooltip — meaning + what-breaks for a trust state. Fixed-positioned at
// the cursor, pointer-events-none (never blocks node clicks), and flips near
// the viewport edges so it can't get clipped.
function TrustTooltip({ trust, x, y }: Tip) {
  const copy = TRUST_COPY[trust];
  const color = toneVar(trust);
  const W = 288;
  const H = 132;
  const left = x + 16 + W > window.innerWidth ? x - W - 16 : x + 16;
  const top = y + 16 + H > window.innerHeight ? y - H - 16 : y + 16;
  return (
    <div
      className="pointer-events-none fixed z-50 w-72 rounded-md border bg-neutral-900 p-3 text-xs shadow-xl"
      style={{ left, top, borderColor: 'var(--color-border-subtle)' }}
    >
      <div className="mb-1.5 flex items-baseline gap-1.5">
        <span className="font-semibold" style={{ color }}>
          {copy.plain}
        </span>
        <span className="text-[11px] text-neutral-500">{trust}</span>
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
        data: { language: w.language, direction: w.direction, trust: w.trust, count: w.count },
      });
    });

    const usage = contract.columnUsage ?? [];
    nodes.push({
      id: contract.id,
      type: 'spine',
      position: { x: LANE_B_X, y: spineY },
      data: {
        label: contract.label,
        columnCount: contract.columns?.length ?? 0,
        deadCount: usage.filter((u) => u.verdict === 'likely_dead').length,
        unknownCount: usage.filter((u) => u.verdict === 'unknown').length,
        writtenNothingReads: model.flags.writtenNothingReads,
        readNothingWrites: model.flags.readNothingWrites,
      },
    });

    readers.forEach((r, i) => {
      nodes.push({
        id: `agg:${r.key}`,
        type: 'aggregate',
        position: { x: LANE_C_X, y: readersOffset + i * LANE_GAP },
        data: { language: r.language, direction: r.direction, trust: r.trust, count: r.count },
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
        data: { trust: w.trust },
        style: { stroke: writeColor, strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: writeColor },
        label: edgeLabel(w.direction, w.trust),
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
        data: { trust: r.trust },
        style: { stroke: readColor, strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: readColor },
        label: edgeLabel(r.direction, r.trust),
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
  const rf = useReactFlow();
  useEffect(() => {
    const id = requestAnimationFrame(() => rf.fitView({ padding: 0.2, duration: 0 }));
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
  const trustOf = (data: unknown): Trust | undefined =>
    (data as { trust?: Trust } | undefined)?.trust;

  const showNodeTip: NodeMouseHandler = (e, node) => {
    const trust = trustOf(node.data);
    if (node.type === 'aggregate' && trust) setTip({ trust, x: e.clientX, y: e.clientY });
  };
  const showEdgeTip: EdgeMouseHandler = (e, edge) => {
    const trust = trustOf(edge.data);
    if (trust) setTip({ trust, x: e.clientX, y: e.clientY });
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
        fitViewOptions={{ padding: 0.2, duration: 0 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--color-grid)" gap={20} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {tip ? <TrustTooltip {...tip} /> : null}
    </div>
  );
}
