import { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type { EdgeDirection, Graph, GraphNode, Language, Trust } from '@throughline/core';
import { fetchGraph } from './lib/api';
import { applyFilters, defaultFilterState, toggle } from './lib/filters';
import { buildContractSummaries, buildFocusModel, type FocusAggregate } from './lib/focus';
import { langTag } from './lib/trust';
import { GraphCanvas } from './components/GraphCanvas';
import { FilterBar } from './components/FilterBar';
import { Inspector, type AggregateSelection } from './components/Inspector';
import { ContractPicker } from './components/ContractPicker';
import { FocusCanvas } from './components/FocusCanvas';
import { FocusLegend } from './components/FocusLegend';

type View = 'focus' | 'map';

export function App() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [live, setLive] = useState(false);
  const [view, setView] = useState<View>('focus');
  const [refreshing, setRefreshing] = useState(false);

  // Selection is shared across both views. selectedAggKey is focus-only.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedAggKey, setSelectedAggKey] = useState<string | null>(null);
  const [focusContractId, setFocusContractId] = useState<string | null>(null);

  // Map-view filters (unchanged).
  const [filters, setFilters] = useState(defaultFilterState);

  const loadGraph = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await fetchGraph();
      setGraph(result.graph);
      setLive(result.live);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchGraph().then((result) => {
      if (cancelled) return;
      setGraph(result.graph);
      setLive(result.live);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Focus view derivations ---
  const summaries = useMemo(() => (graph ? buildContractSummaries(graph) : []), [graph]);
  const focusModel = useMemo(
    () => (graph && focusContractId ? buildFocusModel(graph, focusContractId) : null),
    [graph, focusContractId],
  );

  // Default-select the worst contract (top of the sorted picker) once loaded.
  useEffect(() => {
    if (graph && focusContractId === null && summaries.length > 0) {
      setFocusContractId(summaries[0].id);
      setSelectedId(summaries[0].id);
    }
  }, [graph, summaries, focusContractId]);

  // --- Map view derivations (unchanged) ---
  const filteredGraph = useMemo(
    () => (graph ? applyFilters(graph, filters) : null),
    [graph, filters],
  );
  const contracts = useMemo(
    () =>
      (graph?.nodes ?? [])
        .filter((n) => n.kind === 'contract')
        .map((n) => ({ id: n.id, label: n.label }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [graph],
  );

  // Inspector reads from the full graph so a node stays inspectable (with full
  // AI context) even when filtered out of the canvas.
  const selectedNode = useMemo(
    () => graph?.nodes.find((n) => n.id === selectedId) ?? null,
    [graph, selectedId],
  );

  // When an aggregate is selected in focus view, resolve its touch nodes.
  const inspectorAggregate = useMemo<AggregateSelection | null>(() => {
    if (view !== 'focus' || !selectedAggKey || !focusModel || !graph) return null;
    const agg = [...focusModel.writers, ...focusModel.readers].find((a) => a.key === selectedAggKey);
    if (!agg) return null;
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const touches = agg.touchIds
      .map((id) => byId.get(id))
      .filter((n): n is GraphNode => Boolean(n));
    return { title: `${langTag(agg.language)} ${agg.direction} · ${agg.trust}`, touches };
  }, [view, selectedAggKey, focusModel, graph]);

  const selectContract = (id: string) => {
    setFocusContractId(id);
    setSelectedId(id); // inspect the table by default
    setSelectedAggKey(null);
  };
  const selectFocusNode = (id: string) => {
    setSelectedId(id);
    setSelectedAggKey(null);
  };
  const selectFocusAggregate = (agg: FocusAggregate) => {
    setSelectedAggKey(agg.key);
    setSelectedId(null);
  };
  const clearFocusSelection = () => {
    setSelectedId(null);
    setSelectedAggKey(null);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-neutral-800 px-5 py-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold tracking-tight text-neutral-100">
            Throughline <span className="font-normal text-neutral-500">— codebase X-ray</span>
          </h1>
          <p className="truncate text-xs text-neutral-500">
            {graph ? graph.repoPath : 'loading…'}
            {graph ? ` · ${graph.nodes.length} nodes · ${graph.drift.length} drift` : ''}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* View toggle — focus is the landing view; the full map stays available. */}
          <div className="flex rounded-md border border-neutral-800 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setView('focus')}
              className={`rounded px-3 py-1 font-medium transition ${
                view === 'focus' ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              Focus
            </button>
            <button
              type="button"
              onClick={() => setView('map')}
              className={`rounded px-3 py-1 font-medium transition ${
                view === 'map' ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              Full map
            </button>
          </div>

          <button
            type="button"
            onClick={() => void loadGraph()}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-md border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-300 transition hover:border-neutral-500 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
            title="Re-analyze the connected codebase"
          >
            <span className={`inline-block ${refreshing ? 'animate-spin' : ''}`}>↻</span>
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>

          <span
            className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${
              live ? 'border-trust-verified text-neutral-300' : 'border-neutral-700 text-neutral-400'
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${live ? 'bg-trust-verified' : 'bg-neutral-500'}`} />
            {live ? 'Live (analyzer)' : 'Mock (offline)'}
          </span>
        </div>
      </header>

      {view === 'focus' ? (
        <main className="flex min-h-0 flex-1">
          {/* LEFT — contract picker */}
          <aside className="w-72 shrink-0 border-r border-neutral-800 bg-neutral-950">
            <ContractPicker
              summaries={summaries}
              selectedId={focusContractId}
              onSelect={selectContract}
            />
          </aside>

          {/* CENTER — the focus flow + persistent legend */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="grid grid-cols-3 border-b border-neutral-800 bg-neutral-900 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
              <div className="px-4 py-2">Writers — data enters</div>
              <div className="px-4 py-2 text-center text-neutral-300">Source of truth</div>
              <div className="px-4 py-2 text-right">Readers — data exits</div>
            </div>
            <div className="min-h-0 flex-1">
              {focusModel ? (
                <ReactFlowProvider key={focusModel.contract.id}>
                  <FocusCanvas
                    model={focusModel}
                    live={live}
                    selectedId={selectedId}
                    selectedAggKey={selectedAggKey}
                    onSelectNode={selectFocusNode}
                    onSelectAggregate={selectFocusAggregate}
                    onClear={clearFocusSelection}
                  />
                </ReactFlowProvider>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-neutral-500">
                  {graph ? 'Select a contract to focus.' : 'Loading graph…'}
                </div>
              )}
            </div>
            <FocusLegend />
          </div>

          {/* RIGHT — inspector */}
          <aside className="w-96 shrink-0 border-l border-neutral-800 bg-neutral-950">
            <Inspector
              node={selectedNode}
              graph={graph}
              drift={graph?.drift ?? []}
              aggregate={inspectorAggregate}
            />
          </aside>
        </main>
      ) : (
        <>
          {graph ? (
            <FilterBar
              state={filters}
              contracts={contracts}
              visibleNodes={filteredGraph?.nodes.length ?? 0}
              totalNodes={graph.nodes.length}
              onToggleTrust={(t: Trust) => setFilters((f) => ({ ...f, trust: toggle(f.trust, t) }))}
              onToggleLang={(l: Language) =>
                setFilters((f) => ({ ...f, languages: toggle(f.languages, l) }))
              }
              onToggleDir={(d: EdgeDirection) =>
                setFilters((f) => ({ ...f, directions: toggle(f.directions, d) }))
              }
              onFocus={(id) => setFilters((f) => ({ ...f, focusContractId: id }))}
              onReset={() => setFilters(defaultFilterState())}
            />
          ) : null}

          <main className="flex min-h-0 flex-1">
            <div className="min-w-0 flex-1">
              {filteredGraph ? (
                <ReactFlowProvider>
                  <GraphCanvas
                    graph={filteredGraph}
                    live={live}
                    selectedId={selectedId}
                    onSelect={(id) => setSelectedId(id || null)}
                  />
                </ReactFlowProvider>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-neutral-500">
                  Loading graph…
                </div>
              )}
            </div>
            <aside className="w-96 shrink-0 border-l border-neutral-800 bg-neutral-950">
              <Inspector node={selectedNode} graph={graph} drift={graph?.drift ?? []} />
            </aside>
          </main>
        </>
      )}
    </div>
  );
}
