import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  Panel,
  ReactFlow,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeMouseHandler,
  type Node,
  type NodeMouseHandler,
} from '@xyflow/react';
import dagre from 'dagre';
import type { EdgeDirection, Graph } from '@throughline/core';
import { TrustNode, type TrustNodeData } from './TrustNode';
import { Legend } from './Legend';

const nodeTypes = { trust: TrustNode };

// Card dimensions Dagre reserves per node (matches TrustNode's w-[220px]).
const NODE_W = 220;
const NODE_H = 76;
const LOD_ZOOM = 0.6;
const DIM_OPACITY = 0.3;
// Above this many edges, skip animation even when live — animating hundreds of
// dashed paths at once is the main frame-rate cost. Filtering down re-enables it.
const ANIMATE_MAX_EDGES = 120;

interface GraphCanvasProps {
  graph: Graph;
  live: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

type Hover = { type: 'node' | 'edge'; id: string } | null;

// §6 — programmatic Dagre layout (no hand-placed coords). rankdir LR with
// readers ranked upstream (left) of contracts and writers downstream (right):
// the render edge always points touch -> contract, but the RANK edge is
// flipped for writes so the spine falls out naturally.
function layoutGraph(graph: Graph): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 18, ranksep: 160, marginx: 48, marginy: 48 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of graph.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of graph.edges) {
    if (e.direction === 'write') g.setEdge(e.target, e.source); // contract -> writer (downstream)
    else g.setEdge(e.source, e.target); // reader -> contract (upstream)
  }

  dagre.layout(g);

  const nodes: Node[] = graph.nodes.map((n) => {
    const p = g.node(n.id);
    const data: TrustNodeData = {
      label: n.label,
      kind: n.kind,
      trust: n.trust,
      language: n.language,
      columnCount: n.columns?.length,
      filePath: n.source?.filePath,
    };
    return {
      id: n.id,
      type: 'trust',
      // Dagre returns centers; React Flow wants top-left.
      position: { x: (p?.x ?? 0) - NODE_W / 2, y: (p?.y ?? 0) - NODE_H / 2 },
      data,
      draggable: false,
    };
  });

  const edges: Edge[] = graph.edges.map((e) => routeEdge(e.id, e.source, e.target, e.direction));
  return { nodes, edges };
}

function routeEdge(id: string, source: string, target: string, direction: EdgeDirection): Edge {
  const isWrite = direction === 'write';
  const color = isWrite ? 'var(--color-edge-write)' : 'var(--color-edge-read)';
  return {
    id,
    source,
    target,
    // Readers sit left of the contract; writers right. Route handles inward.
    sourceHandle: isWrite ? 'sl' : 'sr',
    targetHandle: isWrite ? 'tr' : 'tl',
    style: { stroke: color, strokeWidth: 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed, color },
    data: { color },
  };
}

export function GraphCanvas({ graph, live, selectedId, onSelect }: GraphCanvasProps) {
  const [hover, setHover] = useState<Hover>(null);

  // §7 — heavy layout pass keyed strictly on node ids + edge ids. Pan/zoom/
  // select/hover never re-run this.
  const layoutKey = useMemo(
    () => `${graph.nodes.map((n) => n.id).join(',')}|${graph.edges.map((e) => e.id).join(',')}`,
    [graph],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const base = useMemo(() => layoutGraph(graph), [layoutKey]);

  // Adjacency + edge endpoints for hover dimming (cheap, keyed on layout).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const adjacency = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
      const set = m.get(a) ?? new Set<string>();
      set.add(b);
      m.set(a, set);
    };
    for (const e of graph.edges) {
      link(e.source, e.target);
      link(e.target, e.source);
    }
    return m;
  }, [layoutKey]);

  const edgeEndpoints = useMemo(() => {
    const m = new Map<string, { source: string; target: string }>();
    for (const e of base.edges) m.set(e.id, { source: e.source, target: e.target });
    return m;
  }, [base.edges]);

  // Active sets: which nodes/edges stay at full opacity given the hover target.
  const active = useMemo(() => {
    if (!hover) return null;
    if (hover.type === 'node') {
      const nodes = new Set<string>([hover.id, ...(adjacency.get(hover.id) ?? [])]);
      return { nodes, edgeId: null as string | null };
    }
    const ep = edgeEndpoints.get(hover.id);
    return { nodes: new Set([ep?.source ?? '', ep?.target ?? '']), edgeId: hover.id };
  }, [hover, adjacency, edgeEndpoints]);

  // Cheap O(n) derivations — selection, hover dimming, live animation.
  const nodes = useMemo(
    () =>
      base.nodes.map((n) => ({
        ...n,
        selected: n.id === selectedId,
        style: { opacity: active && !active.nodes.has(n.id) ? DIM_OPACITY : 1 },
      })),
    [base.nodes, selectedId, active],
  );

  const animate = live && base.edges.length <= ANIMATE_MAX_EDGES;
  const edges = useMemo(
    () =>
      base.edges.map((e) => {
        const isActiveEdge =
          !active || (active.edgeId ? active.edgeId === e.id : active.nodes.has(e.source) && active.nodes.has(e.target));
        const baseColor = (e.data as { color?: string } | undefined)?.color;
        return {
          ...e,
          animated: animate,
          style: {
            ...e.style,
            stroke: baseColor,
            strokeWidth: active?.edgeId === e.id ? 2 : 1.5,
            opacity: isActiveEdge ? 1 : DIM_OPACITY,
          },
        };
      }),
    [base.edges, animate, active],
  );

  const elementCount = base.nodes.length + base.edges.length;
  const lod = useStore((s) => s.transform[2] < LOD_ZOOM);

  // Refit the viewport whenever the (filtered) node/edge set changes, so a
  // smaller filtered graph fills the canvas instead of leaving the old viewport.
  const rf = useReactFlow();
  useEffect(() => {
    const id = requestAnimationFrame(() => rf.fitView({ padding: 0.2, duration: 0 }));
    return () => cancelAnimationFrame(id);
  }, [layoutKey, rf]);

  const handleNodeClick: NodeMouseHandler = (_e, node) => onSelect(node.id);
  const handleNodeEnter: NodeMouseHandler = (_e, node) => setHover({ type: 'node', id: node.id });
  const handleEdgeEnter: EdgeMouseHandler = (_e, edge) => setHover({ type: 'edge', id: edge.id });
  const clearHover = () => setHover(null);

  return (
    <div className={`h-full w-full ${lod ? 'lod' : ''}`}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        onNodeMouseEnter={handleNodeEnter}
        onNodeMouseLeave={clearHover}
        onEdgeMouseEnter={handleEdgeEnter}
        onEdgeMouseLeave={clearHover}
        onPaneClick={() => onSelect('')}
        nodesDraggable={false}
        nodesConnectable={false}
        minZoom={0.05}
        fitView
        fitViewOptions={{ padding: 0.2, duration: elementCount > 200 ? 0 : 300 }}
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--color-grid)" gap={20} />
        <Controls showInteractive={false} />
        <Panel position="top-left">
          <Legend />
        </Panel>
      </ReactFlow>
    </div>
  );
}
