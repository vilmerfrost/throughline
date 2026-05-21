import { useEffect, useState } from 'react';
import type { GraphNode } from '@throughline/core';
import {
  explainNode,
  fetchFixPrompt,
  type ExplainMode,
  type ExplainSource,
  type FixPromptResult,
  type StructuredExplanation,
} from '../lib/api';
import { SourceLink } from './SourceLink';

interface ExplainPanelProps {
  node: GraphNode;
  context: Record<string, unknown>;
}

interface NodeCacheEntry {
  prompt: string;
  mode: ExplainMode;
  showAllSources: boolean;
  fixPrompt: FixPromptResult | null;
  explanation: string | null;
  structured: StructuredExplanation | null;
  sources: ExplainSource[];
  model: string | null;
}

const panelCache = new Map<string, NodeCacheEntry>();

function updateCache(nodeId: string, updates: Partial<NodeCacheEntry>) {
  const current = panelCache.get(nodeId) || {
    prompt: '',
    mode: 'focused',
    showAllSources: false,
    fixPrompt: null,
    explanation: null,
    structured: null,
    sources: [],
    model: null,
  };
  panelCache.set(nodeId, { ...current, ...updates });
}

export function ExplainPanel({ node, context }: ExplainPanelProps) {
  const [explanation, setExplanation] = useState<string | null>(null);
  const [structured, setStructured] = useState<StructuredExplanation | null>(null);
  const [sources, setSources] = useState<ExplainSource[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<ExplainMode>('focused');
  const [showAllSources, setShowAllSources] = useState(false);
  const [fixPrompt, setFixPrompt] = useState<FixPromptResult | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const [fixLoading, setFixLoading] = useState(false);
  const [fixCopied, setFixCopied] = useState(false);

  // Restore cached state or reset when the node selection changes to prevent
  // bleeding of transient state across selections, while preserving previously
  // fetched explanations and fix prompts to save tokens and time.
  useEffect(() => {
    const cached = panelCache.get(node.id);
    if (cached) {
      setExplanation(cached.explanation);
      setStructured(cached.structured);
      setSources(cached.sources);
      setModel(cached.model);
      setPrompt(cached.prompt);
      setMode(cached.mode);
      setShowAllSources(cached.showAllSources);
      setFixPrompt(cached.fixPrompt);
    } else {
      setExplanation(null);
      setStructured(null);
      setSources([]);
      setModel(null);
      setPrompt('');
      setMode('focused');
      setShowAllSources(false);
      setFixPrompt(null);
    }
    setError(null);
    setFixError(null);
    setFixCopied(false);
  }, [node.id]);

  async function handleFixPrompt() {
    setFixLoading(true);
    setFixError(null);
    setFixPrompt(null);
    setFixCopied(false);
    try {
      const result = await fetchFixPrompt(node, context);
      setFixPrompt(result);
      updateCache(node.id, { fixPrompt: result });
    } catch (err) {
      setFixError(err instanceof Error ? err.message : String(err));
    } finally {
      setFixLoading(false);
    }
  }

  async function handleCopyFix() {
    if (!fixPrompt) return;
    try {
      await navigator.clipboard.writeText(fixPrompt.prompt);
      setFixCopied(true);
      window.setTimeout(() => setFixCopied(false), 2000);
    } catch {
      setFixError('Could not copy to clipboard.');
    }
  }

  function handleOpenInCursor() {
    if (!fixPrompt) return;
    const url = `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(fixPrompt.prompt)}`;
    window.location.href = url;
  }

  async function handleExplain(nextPrompt = prompt) {
    setLoading(true);
    setError(null);
    setExplanation(null);
    setStructured(null);
    setSources([]);
    setModel(null);
    setShowAllSources(false);
    try {
      const result = await explainNode(node, context, {
        prompt: nextPrompt,
        mode,
      });
      setExplanation(result.explanation);
      setStructured(result.structured ?? null);
      setSources(result.sources);
      setModel(result.model ?? null);
      updateCache(node.id, {
        explanation: result.explanation,
        structured: result.structured ?? null,
        sources: result.sources,
        model: result.model ?? null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const visibleSources = showAllSources ? sources : sources.slice(0, 3);

  const handleSetMode = (nextMode: ExplainMode) => {
    setMode(nextMode);
    updateCache(node.id, { mode: nextMode });
  };

  const handleSetPrompt = (nextPrompt: string) => {
    setPrompt(nextPrompt);
    updateCache(node.id, { prompt: nextPrompt });
  };

  const handleToggleShowAllSources = () => {
    setShowAllSources((prev) => {
      const next = !prev;
      updateCache(node.id, { showAllSources: next });
      return next;
    });
  };

  return (
    <div className="mt-auto space-y-3 border-t border-neutral-800 pt-4">
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <label
            htmlFor={`ai-goal-${node.id}`}
            className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500"
          >
            Ask about this selection
          </label>
          <div className="flex rounded-md border border-neutral-800 bg-neutral-950 p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => handleSetMode('focused')}
              className={`rounded px-2 py-1 transition ${
                mode === 'focused'
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              Focused
            </button>
            <button
              type="button"
              onClick={() => handleSetMode('repo')}
              className={`rounded px-2 py-1 transition ${
                mode === 'repo'
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              Research repo
            </button>
          </div>
        </div>
        <textarea
          id={`ai-goal-${node.id}`}
          value={prompt}
          onChange={(event) => handleSetPrompt(event.target.value)}
          rows={3}
          placeholder="Ask what this means, what could break, or what to fix next..."
          className="w-full resize-none rounded-md border border-neutral-800 bg-black/40 px-3 py-2 text-sm leading-relaxed text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-violet-500"
        />
        <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
          <button
            type="button"
            onClick={() => void handleExplain('Explain this selection and recommend what to check next.')}
            disabled={loading}
            className="rounded-md border px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60"
            style={{ borderColor: 'var(--color-ai)', color: 'var(--color-ai)' }}
          >
            {loading ? 'Researching...' : 'Quick explain'}
          </button>
          <button
            type="button"
            onClick={() => void handleExplain()}
            disabled={loading}
            className="rounded-md bg-violet-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Ask
          </button>
        </div>
        <button
          type="button"
          onClick={() => void handleFixPrompt()}
          disabled={fixLoading}
          className="mt-2 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm font-medium text-neutral-200 transition hover:border-neutral-500 hover:text-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {fixLoading ? 'Building fix prompt...' : 'Generate fix prompt for code agent'}
        </button>
        <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-500">
          {mode === 'focused'
            ? 'Focused reads only selected and directly connected sources.'
            : 'Research repo asks the model to inspect approved source references first.'}
        </p>
      </div>

      {error ? (
        <div
          className="mt-3 rounded-md border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--color-asserted)', color: 'var(--color-asserted)' }}
        >
          {error}
        </div>
      ) : null}

      {fixError ? (
        <div
          className="mt-3 rounded-md border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--color-asserted)', color: 'var(--color-asserted)' }}
        >
          {fixError}
        </div>
      ) : null}

      {fixPrompt ? (
        <div
          className="mt-3 rounded-md border bg-neutral-950 p-3"
          style={{
            borderColor:
              fixPrompt.kind === 'analyzer-only'
                ? 'var(--color-narrowed)'
                : fixPrompt.kind === 'no-fix-needed'
                  ? 'var(--color-verified)'
                  : 'var(--color-ai)',
          }}
        >
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span
              className="text-[11px] font-semibold uppercase tracking-wide"
              style={{
                color:
                  fixPrompt.kind === 'analyzer-only'
                    ? 'var(--color-narrowed)'
                    : fixPrompt.kind === 'no-fix-needed'
                      ? 'var(--color-verified)'
                      : 'var(--color-ai)',
              }}
            >
              {fixPrompt.kind === 'analyzer-only'
                ? 'Analyzer-only fix'
                : fixPrompt.kind === 'no-fix-needed'
                  ? 'No fix needed'
                  : 'Fix prompt'}
            </span>
            <span className="text-[11px] text-neutral-500">deterministic, no LLM</span>
          </div>
          <p className="text-xs leading-relaxed text-neutral-300">{fixPrompt.summary}</p>
          <pre className="mt-2 max-h-72 overflow-y-auto rounded-md border border-neutral-800 bg-black/60 p-3 text-[11px] leading-relaxed text-neutral-200">
            {fixPrompt.prompt}
          </pre>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => void handleCopyFix()}
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-200 transition hover:border-neutral-500 hover:text-neutral-50"
            >
              {fixCopied ? 'Copied!' : 'Copy prompt'}
            </button>
            <button
              type="button"
              onClick={handleOpenInCursor}
              className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-violet-500"
            >
              Open in Cursor
            </button>
          </div>
        </div>
      ) : null}

      {explanation ? (
        <div
          className="mt-3 rounded-md border-l-2 bg-neutral-900 p-3"
          style={{ borderColor: 'var(--color-ai)' }}
        >
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide">
            <span style={{ color: 'var(--color-ai)' }}>AI explanation</span>
            <span className="font-normal normal-case tracking-normal text-neutral-500">
              commentary, not source of truth
            </span>
          </div>
          {structured ? (
            <StructuredExplanationView structured={structured} fallback={explanation} />
          ) : (
            <div className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-200">
              {explanation}
            </div>
          )}
          {model ? <div className="mt-2 font-mono text-[11px] text-neutral-600">{model}</div> : null}
          {sources.length > 0 ? (
            <div className="mt-3 border-t border-neutral-800 pt-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                Sources checked
              </div>
              <ul className="space-y-1">
                {visibleSources.map((source) => (
                  <li
                    key={`${source.filePath}:${source.startLine}`}
                    className="font-mono text-[11px] text-neutral-400"
                  >
                    <SourceLink source={source}>{source.label}</SourceLink>
                  </li>
                ))}
              </ul>
              {sources.length > 3 ? (
                <button
                  type="button"
                  onClick={handleToggleShowAllSources}
                  className="mt-2 text-[11px] font-medium text-neutral-400 underline decoration-neutral-700 underline-offset-2 hover:text-neutral-100"
                >
                  {showAllSources ? 'Show fewer sources' : `View ${sources.length - 3} more sources`}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StructuredExplanationView({
  structured,
  fallback,
}: {
  structured: StructuredExplanation;
  fallback: string;
}) {
  const sections = [
    ['What this is', structured.what],
    ['Evidence', structured.evidence],
    ['Risk / confidence', structured.risk],
    ['Recommended next actions', structured.actions],
    ['Conclusion', structured.conclusion],
    ['Recap', structured.recap],
  ] as const;
  const visibleSections = sections.filter(([, body]) => body.trim().length > 0);

  if (!visibleSections.length) {
    return <div className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-200">{fallback}</div>;
  }

  return (
    <div className="space-y-3 text-sm leading-relaxed text-neutral-200">
      {visibleSections.map(([title, body], index) => (
        <section
          key={title}
          className={
            title === 'Recap' && index > 0
              ? 'mt-1 border-t border-neutral-800 pt-3 text-neutral-300'
              : ''
          }
        >
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
            {title}
          </h3>
          <div className="whitespace-pre-wrap">{body}</div>
        </section>
      ))}
    </div>
  );
}
