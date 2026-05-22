import { useState } from 'react';
import type { GraphNode } from '@throughline/core';
import { fetchFixPrompt, type FixPromptResult } from '../lib/api';

interface FixPromptBlockProps {
  node: GraphNode;
  context: Record<string, unknown>;
  // Button label — lets callers say "Generate fix prompt for this root cause".
  label?: string;
}

// Self-contained "Generate fix prompt" control: calls the same deterministic
// /fix-prompt endpoint the inspector uses, then renders the result with a copy
// button. Reused by the Root Causes view so a root cause can be fixed at once.
export function FixPromptBlock({ node, context, label = 'Generate fix prompt' }: FixPromptBlockProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FixPromptResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleGenerate() {
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      setResult(await fetchFixPrompt(node, context));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — no-op */
    }
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => void handleGenerate()}
        disabled={loading}
        className="rounded-md border px-3 py-1.5 text-xs font-medium text-neutral-100 transition hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-60"
        style={{ borderColor: 'var(--color-ai)' }}
      >
        {loading ? 'Building fix prompt…' : result ? 'Regenerate fix prompt' : label}
      </button>

      {error ? <p className="mt-2 text-xs text-trust-asserted">{error}</p> : null}

      {result ? (
        <div className="mt-2 rounded-md border bg-black/40 p-3" style={{ borderColor: 'var(--color-ai)' }}>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span
              className="text-[11px] font-semibold uppercase tracking-wide"
              style={{ color: 'var(--color-ai)' }}
            >
              Root-cause fix prompt
            </span>
            <span className="text-[11px] text-neutral-500">deterministic · targets the root</span>
          </div>
          {result.summary ? (
            <p className="text-xs leading-relaxed text-neutral-300">{result.summary}</p>
          ) : null}
          <pre className="mt-2 max-h-72 overflow-y-auto rounded-md border border-neutral-800 bg-black/60 p-3 text-[11px] leading-relaxed text-neutral-200 whitespace-pre-wrap">
            {result.prompt}
          </pre>
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="mt-2 rounded-md border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-200 transition hover:border-neutral-500 hover:text-neutral-50"
          >
            {copied ? 'Copied!' : 'Copy prompt'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
