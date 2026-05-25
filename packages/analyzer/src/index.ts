import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import type { GraphNode } from '@throughline/core';
import { explainHandler, type ExplainContext } from './explain.js';
import { buildGraph } from './buildGraph.js';
import { buildFixPrompt, polishFixPromptWithLLM } from './fixPrompt.js';

const execFileAsync = promisify(execFile);

// Load env (incl. OPENROUTER_API_KEY) from the repo root and the package dir.
// The key stays server-side; the frontend only ever talks to /explain.
const cwd = process.cwd();
dotenv.config({
  path: [
    path.join(cwd, '.env.local'),
    path.join(cwd, '.env'),
    path.join(cwd, '../../.env.local'),
    path.join(cwd, '../../.env'),
  ],
});

const PORT = 4000;

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// POST /explain  ->  { explanation } — plain-language, facts-only explanation
// of a selected node via OpenRouter. The API key never leaves the server.
app.post('/explain', explainHandler);

// POST /fix-prompt -> { prompt, kind, summary } — agent-ready prompt for the
// receiving codebase. The deterministic template (built from analyzer-verified
// facts) is the grounding; an LLM polish pass rewrites it as a natural
// self-contained task. Falls back to the raw template if no API key.
app.post('/fix-prompt', async (req, res) => {
  const node = req.body?.node as GraphNode | undefined;
  const context = (req.body?.context ?? {}) as ExplainContext;
  if (!node || typeof node.id !== 'string' || typeof node.kind !== 'string') {
    res.status(400).json({ error: 'Invalid request: expected a node with id and kind.' });
    return;
  }
  const brief = buildFixPrompt(node, context);
  const polished = await polishFixPromptWithLLM(brief, process.env.OPENROUTER_API_KEY);
  res.json(polished);
});

function resolveRepoPath(repoPath: string): string {
  if (!repoPath || repoPath === '<mock-repo>') {
    return '/Users/vilmerfrost/Projects/Batch-Guard.ai-2';
  }

  // Normalize spelling typos (e.g. batchgaurd -> Batch-Guard), missing hyphens, and different casings
  const lower = repoPath.toLowerCase();
  if (
    lower.includes('batchgaurd') || 
    lower.includes('batchguard') || 
    lower.includes('batch-guard')
  ) {
    const targetPath = '/Users/vilmerfrost/Projects/Batch-Guard.ai-2';
    if (fs.existsSync(targetPath)) {
      return targetPath;
    }
  }

  return repoPath;
}

// GET /analyze?path=/some/repo  ->  Graph JSON
app.get('/analyze', async (req, res) => {
  const rawPath = typeof req.query.path === 'string' ? req.query.path : '<mock-repo>';
  const repoPath = resolveRepoPath(rawPath);
  res.json(await buildGraph(repoPath));
});

// Walk up from this file (packages/analyzer/src/index.ts) until we find the
// monorepo root (where pnpm-workspace.yaml lives). This makes the MCP config
// portable: the user's checkout could be anywhere on disk.
function resolveThroughlineRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(here, '../../..');
}

// GET /mcp-config -> the absolute paths needed to render an MCP config snippet
// (Cursor / Claude Desktop / Claude Code) in the web UI. The web app then
// constructs the JSON/CLI strings client-side. We return platform-specific
// tsx binary names so the same response works on Mac/Linux + Windows.
app.get('/mcp-config', (_req, res) => {
  const root = resolveThroughlineRoot();
  const mcpDir = path.join(root, 'packages', 'mcp');
  const tsxBinPosix = path.join(mcpDir, 'node_modules', '.bin', 'tsx');
  const tsxBinWindows = path.join(mcpDir, 'node_modules', '.bin', 'tsx.cmd');
  const entry = path.join(mcpDir, 'src', 'index.ts');
  res.json({
    throughlineRoot: root,
    mcpEntry: entry,
    tsxBinPosix,
    tsxBinWindows,
    platform: process.platform,
  });
});

// POST /pick-folder -> { path: string } | { cancelled: true }
// Opens a native OS folder picker so the user can choose a codebase without
// typing an absolute path. Uses built-in OS tools — no native dependency:
//   - macOS:   osascript "choose folder"
//   - Windows: PowerShell FolderBrowserDialog
//   - Linux:   zenity (if installed) — graceful fallback if missing
app.post('/pick-folder', async (_req, res) => {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('osascript', [
        '-e',
        'POSIX path of (choose folder with prompt "Choose your codebase folder")',
      ]);
      const picked = stdout.trim().replace(/\/$/, '');
      if (!picked) {
        res.json({ cancelled: true });
        return;
      }
      res.json({ path: picked });
      return;
    }

    if (process.platform === 'win32') {
      // PowerShell one-liner. Output is the absolute path or empty on cancel.
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
        '$f.Description = "Choose your codebase folder"',
        '$null = $f.ShowDialog()',
        'Write-Output $f.SelectedPath',
      ].join('; ');
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ]);
      const picked = stdout.trim();
      if (!picked) {
        res.json({ cancelled: true });
        return;
      }
      res.json({ path: picked });
      return;
    }

    // Linux fallback — try zenity, otherwise tell the caller to type a path.
    try {
      const { stdout } = await execFileAsync('zenity', [
        '--file-selection',
        '--directory',
        '--title=Choose your codebase folder',
      ]);
      const picked = stdout.trim();
      if (!picked) {
        res.json({ cancelled: true });
        return;
      }
      res.json({ path: picked });
    } catch {
      res.status(501).json({
        error:
          'No native folder picker available on this platform. Type or paste the absolute path instead.',
      });
    }
  } catch (err) {
    // execFile rejects on non-zero exit (e.g. user cancels osascript). Treat
    // that as a clean cancel rather than a server error.
    const message = err instanceof Error ? err.message : String(err);
    if (/User canceled|cancelled|cancel/i.test(message)) {
      res.json({ cancelled: true });
      return;
    }
    res.status(500).json({ error: `Folder picker failed: ${message}` });
  }
});

app.listen(PORT, () => {
  console.log(`[throughline] analyzer listening on http://localhost:${PORT}`);
  console.log(`[throughline] try: http://localhost:${PORT}/analyze?path=/path/to/repo`);
});
