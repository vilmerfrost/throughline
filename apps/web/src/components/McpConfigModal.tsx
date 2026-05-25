import { useEffect, useMemo, useState } from 'react';
import { fetchMcpConfigInfo, type McpConfigInfo } from '../lib/api';

interface McpConfigModalProps {
  open: boolean;
  onClose: () => void;
  // The currently-analyzed repo path. Pre-fills THROUGHLINE_REPO in the JSON
  // config so the snippet matches what the user is actually inspecting.
  currentRepoPath?: string | null;
}

type Os = 'mac' | 'win';

// Renders a self-contained "install Throughline MCP" panel. The web app can't
// know where the user's throughline checkout lives, so it asks the analyzer
// via /mcp-config and templates the JSON/CLI/install-prompt on the client.
// Cross-platform: Mac/Linux + Windows tabs swap the tsx binary suffix
// (`tsx` vs `tsx.cmd`) — everything else stays the same.
export function McpConfigModal({ open, onClose, currentRepoPath }: McpConfigModalProps) {
  const [info, setInfo] = useState<McpConfigInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [os, setOs] = useState<Os>('mac');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    fetchMcpConfigInfo()
      .then((result) => {
        if (cancelled) return;
        setInfo(result);
        setOs(result.platform === 'win32' ? 'win' : 'mac');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // ESC closes the modal — small UX nicety expected of any overlay.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const tsxBin = info ? (os === 'win' ? info.tsxBinWindows : info.tsxBinPosix) : '';
  const repoForConfig = currentRepoPath || '<path-to-your-codebase>';

  // The JSON snippet ships in MCP config files (Cursor / Claude Desktop / .mcp.json).
  const jsonConfig = useMemo(() => {
    if (!info) return '';
    return JSON.stringify(
      {
        mcpServers: {
          throughline: {
            command: tsxBin,
            args: [info.mcpEntry],
            env: { THROUGHLINE_REPO: repoForConfig },
          },
        },
      },
      null,
      2,
    );
  }, [info, tsxBin, repoForConfig]);

  // The CLI snippet for Claude Code's `claude mcp add`.
  const claudeCmd = useMemo(() => {
    if (!info) return '';
    return `claude mcp add throughline -- ${tsxBin} ${info.mcpEntry} ${repoForConfig}`;
  }, [info, tsxBin, repoForConfig]);

  // A self-contained prompt the user can hand to any agent (Claude, Cursor,
  // Codex, etc.) so it installs the MCP server end-to-end. We deliberately
  // include both the JSON and the CLI so the agent can pick whichever flow
  // matches the host it's running in.
  const installPrompt = useMemo(() => {
    if (!info) return '';
    const osName = os === 'win' ? 'Windows' : 'macOS / Linux';
    return [
      `Please install the Throughline MCP server for me on this machine (${osName}).`,
      '',
      'Throughline is a read-only, contract-centric codebase X-ray. The MCP server',
      "exposes the analyzer's grounded facts (contracts, touches, trust, drift, root",
      'causes, FK neighbors, check_write) to you over stdio so you can use them.',
      '',
      'Use the configuration below. Pick the install path that matches the agent / IDE',
      'you are currently running in:',
      '',
      '— If you are Claude Code (CLI), run:',
      '',
      '```bash',
      claudeCmd,
      '```',
      '',
      '— If you are Cursor, Claude Desktop, Windsurf, or any MCP client that reads',
      `  a JSON config (\`~/.cursor/mcp.json\`, \`claude_desktop_config.json\`, or a project`,
      '  `.mcp.json`), merge this entry into the `mcpServers` block:',
      '',
      '```json',
      jsonConfig,
      '```',
      '',
      `The \`command\` path above is the package-local \`tsx\` binary inside the`,
      'Throughline monorepo — that matters, because the MCP server imports the',
      '`@throughline/analyzer` workspace package and needs this checkout\'s',
      '`node_modules` reachable.',
      '',
      `Replace \`THROUGHLINE_REPO\` with the absolute path of whichever codebase you`,
      'want me to X-ray (it currently points to what the user is inspecting).',
      '',
      'After installing, verify the server is connected and then call the',
      '`about_throughline` tool once so you understand the trust model before',
      'using any of the other tools.',
    ].join('\n');
  }, [info, os, claudeCmd, jsonConfig]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-center justify-between border-b border-neutral-800 px-5 py-3.5">
          <div>
            <h2 className="text-sm font-semibold tracking-tight text-neutral-100">
              Install the Throughline MCP
            </h2>
            <p className="mt-0.5 text-xs text-neutral-500">
              Lets your coding agent (Cursor, Claude, etc.) query Throughline&apos;s grounded
              facts directly.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-100"
            aria-label="Close"
          >
            Close (Esc)
          </button>
        </header>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <p className="rounded-md border border-trust-asserted/40 bg-trust-asserted/10 p-3 text-xs text-trust-asserted">
              Could not reach the analyzer at <code>localhost:4000</code>: {error}
              <br />
              Make sure <code>pnpm dev</code> is running, then reopen this dialog.
            </p>
          ) : !info ? (
            <p className="text-xs text-neutral-500">Loading config…</p>
          ) : (
            <>
              {/* OS tabs */}
              <div className="mb-4 inline-flex rounded-md border border-neutral-800 p-0.5 text-xs">
                <TabButton active={os === 'mac'} onClick={() => setOs('mac')}>
                  macOS / Linux
                </TabButton>
                <TabButton active={os === 'win'} onClick={() => setOs('win')}>
                  Windows
                </TabButton>
              </div>

              {/* Top — copy install prompt (the headline action) */}
              <Section
                title="One-shot install prompt"
                subtitle="Copy this and paste it to your coding agent. Works in any MCP-aware host."
              >
                <CopyBlock text={installPrompt} buttonLabel="Copy install prompt" tall />
              </Section>

              {/* JSON config */}
              <Section
                title="JSON config (Cursor / Claude Desktop / .mcp.json)"
                subtitle={`Merge into the \`mcpServers\` block of your client's config file.`}
              >
                <CopyBlock text={jsonConfig} buttonLabel="Copy JSON" />
              </Section>

              {/* CLI */}
              <Section
                title="Claude Code CLI"
                subtitle="Run this in a terminal to register the server with Claude Code."
              >
                <CopyBlock text={claudeCmd} buttonLabel="Copy command" mono />
              </Section>

              {/* Footnote */}
              <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
                <strong className="text-neutral-400">THROUGHLINE_REPO</strong> is the
                absolute path of the codebase the MCP server will analyze. It defaults to{' '}
                {currentRepoPath ? (
                  <code className="text-neutral-300">{currentRepoPath}</code>
                ) : (
                  <span>whatever folder is currently selected in the UI</span>
                )}
                . Change the folder in the header to update this snippet, or just
                edit the path in the copied config.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-3 py-1 font-medium transition ${
        active ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
      }`}
    >
      {children}
    </button>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-300">{title}</h3>
      {subtitle ? <p className="mt-0.5 text-[11px] text-neutral-500">{subtitle}</p> : null}
      <div className="mt-2">{children}</div>
    </section>
  );
}

function CopyBlock({
  text,
  buttonLabel,
  mono,
  tall,
}: {
  text: string;
  buttonLabel: string;
  mono?: boolean;
  tall?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — no-op */
    }
  }

  return (
    <div className="rounded-md border border-neutral-800 bg-black/50">
      <pre
        className={`overflow-x-auto p-3 font-mono text-[11px] leading-relaxed text-neutral-200 whitespace-pre-wrap ${
          tall ? 'max-h-64 overflow-y-auto' : ''
        } ${mono ? 'whitespace-pre' : ''}`}
      >
        {text}
      </pre>
      <div className="flex items-center justify-end border-t border-neutral-800 px-2 py-1.5">
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="rounded-md border border-neutral-700 px-3 py-1 text-[11px] font-medium text-neutral-200 transition hover:border-neutral-500 hover:text-neutral-50"
        >
          {copied ? 'Copied!' : buttonLabel}
        </button>
      </div>
    </div>
  );
}
