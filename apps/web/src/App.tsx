import { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type { ColumnReach, EdgeDirection, Graph, GraphNode, Language, Trust } from '@throughline/core';
import { fetchGraph } from './lib/api';
import { applyFilters, defaultFilterState, toggle } from './lib/filters';
import { buildContractSummaries, buildFocusModel, type FocusAggregate } from './lib/focus';
import { contractPasses, emptyFocusFilter, type FocusFilterState } from './lib/focusFilter';
import { langTag, type Verdict } from './lib/trust';
import { GraphCanvas } from './components/GraphCanvas';
import { FilterBar } from './components/FilterBar';
import { Inspector, type AggregateSelection } from './components/Inspector';
import { ContractPicker } from './components/ContractPicker';
import { FocusFilterBar } from './components/FocusFilterBar';
import { FocusCanvas } from './components/FocusCanvas';
import { FocusLegend } from './components/FocusLegend';
import { RelationshipBand } from './components/RelationshipBand';
import { buildRelationshipNeighborhood } from './lib/relationships';
import { RootCausesView } from './components/RootCausesView';

type View = 'focus' | 'roots' | 'map';

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

  // Focus-view triage filter — verdict (touches/contract dot) + reach (columns).
  // Persisted across contract selection (deliberately not reset on select).
  const [focusFilter, setFocusFilter] = useState<FocusFilterState>(emptyFocusFilter);

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

  // FK-A2: the focused contract's foreign-key neighborhood (table↔table), shown
  // as a band beneath the touch canvas. Independent of the verdict/reach filter.
  const neighborhood = useMemo(
    () => (graph && focusContractId ? buildRelationshipNeighborhood(graph, focusContractId) : null),
    [graph, focusContractId],
  );

  // Contract list, narrowed by the triage filter (OR across selected chips).
  const filteredSummaries = useMemo(
    () => summaries.filter((s) => contractPasses(s, focusFilter)),
    [summaries, focusFilter],
  );

  // Within-contract: verdict chips filter the rendered touch aggregates. The
  // full focusModel is kept (for aggregate selection); only the canvas view is
  // narrowed. No verdict chips active = show every touch.
  const displayModel = useMemo(() => {
    if (!focusModel || focusFilter.verdicts.size === 0) return focusModel;
    const keep = (a: FocusAggregate) => focusFilter.verdicts.has(a.verdict);
    return {
      ...focusModel,
      writers: focusModel.writers.filter(keep),
      readers: focusModel.readers.filter(keep),
    };
  }, [focusModel, focusFilter.verdicts]);

  // Toggling a chip clears any root-cause contract scope (they're separate lenses).
  const toggleVerdict = (v: Verdict) =>
    setFocusFilter((f) => ({ ...f, contracts: new Set(), verdicts: toggle(f.verdicts, v) }));
  const toggleReach = (r: ColumnReach) =>
    setFocusFilter((f) => ({ ...f, contracts: new Set(), reaches: toggle(f.reaches, r) }));
  const clearFocusFilter = () => setFocusFilter(emptyFocusFilter());

  // From the Root Causes view: scope the contract list to a root cause's affected
  // contracts and jump to focus so the user can triage them. Reuses the filter.
  const showAffectedContracts = (contracts: string[]) => {
    setFocusFilter({ verdicts: new Set(), reaches: new Set(), contracts: new Set(contracts) });
    const first = summaries.find((s) => contracts.includes(s.label));
    if (first) {
      setFocusContractId(first.id);
      setSelectedId(first.id);
      setSelectedAggKey(null);
    }
    setView('focus');
  };

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
    return { title: `${langTag(agg.language)} ${agg.direction} · ${agg.verdict}`, touches };
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
              onClick={() => setView('roots')}
              className={`rounded px-3 py-1 font-medium transition ${
                view === 'roots' ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              Root Causes
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
          {/* LEFT — triage filter + contract picker */}
          <aside className="flex w-72 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
            <FocusFilterBar
              filter={focusFilter}
              shown={filteredSummaries.length}
              total={summaries.length}
              onToggleVerdict={toggleVerdict}
              onToggleReach={toggleReach}
              onClear={clearFocusFilter}
            />
            <div className="min-h-0 flex-1">
              <ContractPicker
                summaries={filteredSummaries}
                selectedId={focusContractId}
                onSelect={selectContract}
              />
            </div>
          </aside>

          {/* CENTER — the focus flow + persistent legend */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="grid grid-cols-3 border-b border-neutral-800 bg-neutral-900 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
              <div className="px-4 py-2">Writers — data enters</div>
              <div className="px-4 py-2 text-center text-neutral-300">Source of truth</div>
              <div className="px-4 py-2 text-right">Readers — data exits</div>
            </div>
            <div className="min-h-0 flex-1">
              {displayModel ? (
                <ReactFlowProvider key={displayModel.contract.id}>
                  <FocusCanvas
                    model={displayModel}
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
            {neighborhood && (
              <RelationshipBand neighborhood={neighborhood} onSelectContract={selectContract} />
            )}
            <FocusLegend />
          </div>

          {/* RIGHT — inspector */}
          <aside className="w-96 shrink-0 border-l border-neutral-800 bg-neutral-950">
            <Inspector
              node={selectedNode}
              graph={graph}
              drift={graph?.drift ?? []}
              aggregate={inspectorAggregate}
              reachFilter={focusFilter.reaches}
            />
          </aside>
        </main>
      ) : view === 'roots' ? (
        graph ? (
          <RootCausesView graph={graph} onShowAffected={showAffectedContracts} />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-neutral-500">
            Loading graph…
          </div>
        )
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
