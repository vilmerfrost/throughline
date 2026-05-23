import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import type { GraphNode } from '@throughline/core';
import { explainHandler, type ExplainContext } from './explain.js';
import { buildGraph } from './buildGraph.js';
import { buildFixPrompt, polishFixPromptWithLLM } from './fixPrompt.js';

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

app.listen(PORT, () => {
  console.log(`[throughline] analyzer listening on http://localhost:${PORT}`);
  console.log(`[throughline] try: http://localhost:${PORT}/analyze?path=/path/to/repo`);
});
