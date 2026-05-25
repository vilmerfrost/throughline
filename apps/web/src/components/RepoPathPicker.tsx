import { useState } from 'react';
import { pickFolder } from '../lib/api';

interface RepoPathPickerProps {
  // Currently-analyzed absolute path. May be null while loading the initial
  // graph; the picker keeps a working draft and only fires onApply when the
  // user commits a change.
  currentPath: string | null;
  // Whether a reanalysis is currently in flight — disables the apply button.
  refreshing: boolean;
  onApply: (path: string) => void;
}

// Header-level "Folder" control. Two ways to pick a codebase, both cross-platform:
//   1) "Browse…" — asks the analyzer to open the OS's native folder picker
//      (osascript on macOS, PowerShell on Windows, zenity on Linux) and
//      receives back an absolute path.
//   2) A text input — paste/type an absolute path. Useful in environments
//      where no native picker exists (containers, headless dev machines).
// Selecting/applying triggers a fresh /analyze on the new path.
export function RepoPathPicker({ currentPath, refreshing, onApply }: RepoPathPickerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string>(currentPath ?? '');
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleOpen() {
    setDraft(currentPath ?? '');
    setError(null);
    setOpen(true);
  }

  async function handleBrowse() {
    setPicking(true);
    setError(null);
    try {
      const result = await pickFolder();
      if ('path' in result) {
        setDraft(result.path);
      } else if ('error' in result) {
        setError(result.error);
      }
      // 'cancelled' — user closed the dialog, no-op.
    } finally {
      setPicking(false);
    }
  }

  function handleApply() {
    const next = draft.trim();
    if (!next || next === currentPath) {
      setOpen(false);
      return;
    }
    onApply(next);
    setOpen(false);
  }

  // Short display for the header button — truncate from the left so the leaf
  // folder name stays visible (which is what users actually recognize).
  const display = currentPath ? truncateLeft(currentPath, 36) : 'No folder';

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleOpen}
        className="flex items-center gap-1.5 rounded-md border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-300 transition hover:border-neutral-500 hover:text-neutral-100"
        title={currentPath ?? 'Choose a codebase folder'}
      >
        <span aria-hidden>📁</span>
        <span className="font-mono">{display}</span>
      </button>

      {open ? (
        <>
          {/* Click-away overlay */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

          <div className="absolute right-0 top-full z-50 mt-2 w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-neutral-700 bg-neutral-950 p-3 shadow-2xl">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              Codebase folder
            </div>
            <p className="mb-2 text-[11px] leading-relaxed text-neutral-400">
              Throughline X-rays a folder on your local disk. Browse to it or paste an
              absolute path.
            </p>

            <input
              type="text"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              placeholder={
                navigator.userAgent.includes('Windows')
                  ? 'C:\\Users\\me\\Projects\\my-app'
                  : '/Users/me/Projects/my-app'
              }
              className="w-full rounded-md border border-neutral-700 bg-black/40 px-2.5 py-1.5 font-mono text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleApply();
                if (e.key === 'Escape') setOpen(false);
              }}
            />

            {error ? (
              <p className="mt-1.5 text-[11px] text-trust-asserted">{error}</p>
            ) : null}

            <div className="mt-2.5 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => void handleBrowse()}
                disabled={picking}
                className="rounded-md border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-200 transition hover:border-neutral-500 hover:text-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {picking ? 'Opening…' : 'Browse…'}
              </button>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-md px-2.5 py-1 text-xs font-medium text-neutral-400 transition hover:text-neutral-200"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleApply}
                  disabled={refreshing || !draft.trim()}
                  className="rounded-md border border-trust-verified bg-trust-verified/15 px-3 py-1 text-xs font-medium text-neutral-100 transition hover:bg-trust-verified/25 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {refreshing ? 'Analyzing…' : 'Analyze'}
                </button>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function truncateLeft(value: string, max: number): string {
  if (value.length <= max) return value;
  return '…' + value.slice(value.length - max + 1);
}
