import { readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { EdgeDirection, GraphEdge, GraphNode, Language, SourceRef, WriterLifecycle } from '@throughline/core';
import { classifySourceScope } from '../sourceScope.js';
import { classifyWriterLifecycle } from '../lifecycle.js';

// Shallow, line/regex-based detection of Python and Rust touches on the DB
// contracts. NO AST parsing — we accept approximate detection but never
// fabricate. Every shallow touch is `dark`: neither language imports the DB
// types (Python uses dicts, Rust uses serde_json::Value), so no type is
// carried; the writes are "manually kept aligned" with the SQL schema.

const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'out',
  'build',
  'target', // Rust build output
  '__pycache__',
  '.venv',
  'venv',
  'models',
  'training_data',
  '.git',
]);

// Python: `.table("x")` / `.from_("x")` is the supabase-py table accessor.
const PY_TABLE = /\.(?:table|from_)\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/g;
const PY_WRITE = /\.(?:insert|update|upsert|delete)\s*\(/;
const PY_READ = /\.select\s*\(/;
// Raw SQL (uppercase verbs, case-sensitive so Python's lowercase `from x import`
// never matches). Runs even inside docstrings, since SQL lives in strings.
const RAW_SQL = /(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE|FROM)\s+["'`]?([a-z_][a-z0-9_]*)/g;
const RAW_SQL_WRITE = /^(?:INSERT|DELETE|UPDATE)/;

// Rust: tables appear as PostgREST URL paths, e.g. `format!("{}/rest/v1/batches", ...)`.
const RUST_REST = /\/rest\/v1\/([a-z_][a-z0-9_]*)/g;
const RUST_WRITE_VERB = /\.(?:post|patch|put|delete)\s*\(/;
const RUST_READ_VERB = /\.get\s*\(/;

// How far to look for the HTTP verb relative to the URL line (verb may be many
// lines below where the URL string is built; rarely above).
const RUST_LOOK_BACK = 3;
const RUST_LOOK_FWD = 15;
// Python verb is in the same fluent chain — a tight forward window suffices.
const PY_LOOK_FWD = 6;

export interface ShallowResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface Candidate {
  table: string;
  line: number; // 1-based
  direction: EdgeDirection;
  ambiguous: boolean; // direction could not be inferred from a verb
}

export async function grepShallow(
  repoPath: string,
  contracts: GraphNode[],
): Promise<ShallowResult> {
  const known = new Set(contracts.map((c) => c.label));
  const files = await walkSourceFiles(repoPath);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  let rejected = 0;
  let ambiguous = 0;
  const rejectedExamples = new Map<string, number>();

  for (const file of files) {
    const lang: Language = file.endsWith('.py') ? 'python' : 'rust';
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    const rel = path.relative(repoPath, file);
    const candidates = lang === 'python' ? detectPython(lines) : detectRust(lines);

    for (const c of candidates) {
      if (!known.has(c.table)) {
        rejected += 1;
        rejectedExamples.set(c.table, (rejectedExamples.get(c.table) ?? 0) + 1);
        continue;
      }
      const id = `touch:${lang}:${rel}:${c.line}:${c.table}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (c.ambiguous) ambiguous += 1;

      const source: SourceRef = {
        language: lang,
        filePath: rel,
        startLine: c.line,
        endLine: c.line,
        snippet: lines[c.line - 1] ?? '',
      };
      const sourceScope = classifySourceScope(rel);
      const lifecycle: WriterLifecycle | undefined = classifyWriterLifecycle(rel, c.direction, sourceScope);
      nodes.push({
        id,
        kind: 'touch',
        language: lang,
        label: `${c.direction} ${c.table}`,
        trust: 'dark',
        trustReason: lang === 'python' ? 'shallow-grep-python' : 'shallow-grep-rust',
        sourceScope,
        analysisDepth: 'shallow',
        ...(lifecycle ? { lifecycle } : {}),
        source,
        notes: buildNotes(lang, c.direction, c.table),
      });
      edges.push({
        id: `edge:${id}`,
        source: id,
        target: `contract:${c.table}`,
        direction: c.direction,
      });
    }
  }

  if (process.env.THROUGHLINE_SHALLOW_DEBUG) {
    console.error(
      JSON.stringify(
        {
          repoPath,
          files: files.length,
          touches: nodes.length,
          byLanguage: tally(nodes, (n) => n.language ?? '?'),
          byLangDir: tally(nodes, (n) => `${n.language} ${n.label.split(' ')[0]}`),
          pythonTables: tableCounts(nodes, 'python'),
          rustTables: tableCounts(nodes, 'rust'),
          ambiguousDirection: ambiguous,
          rejectedCandidates: rejected,
          rejectedExamples: Object.fromEntries(
            [...rejectedExamples.entries()].sort((a, b) => b[1] - a[1]),
          ),
        },
        null,
        2,
      ),
    );
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Python detection
// ---------------------------------------------------------------------------

function detectPython(lines: string[]): Candidate[] {
  const out: Candidate[] = [];
  let inDocstring = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tripleQuotes = (line.match(/"""|'''/g) ?? []).length;

    // Raw SQL runs regardless of docstring state (SQL is written inside strings).
    for (const m of line.matchAll(RAW_SQL)) {
      const verb = m[0].split(/\s+/)[0];
      out.push({
        table: m[1],
        line: i + 1,
        direction: RAW_SQL_WRITE.test(verb) ? 'write' : 'read',
        ambiguous: false,
      });
    }

    const wasInDoc = inDocstring;
    if (tripleQuotes % 2 === 1) inDocstring = !inDocstring;
    // Skip the supabase accessor pattern inside docstrings / full-line comments
    // to avoid matching prose like `.table("events_log")` in documentation.
    if (wasInDoc || inDocstring || line.trimStart().startsWith('#')) continue;

    for (const m of line.matchAll(PY_TABLE)) {
      const { direction, ambiguous } = pythonDirection(lines, i);
      out.push({ table: m[1], line: i + 1, direction, ambiguous });
    }
  }
  return out;
}

function pythonDirection(lines: string[], i: number): { direction: EdgeDirection; ambiguous: boolean } {
  const end = Math.min(lines.length - 1, i + PY_LOOK_FWD);
  for (let j = i; j <= end; j++) {
    if (PY_WRITE.test(lines[j])) return { direction: 'write', ambiguous: false };
  }
  for (let j = i; j <= end; j++) {
    if (PY_READ.test(lines[j])) return { direction: 'read', ambiguous: false };
  }
  return { direction: 'read', ambiguous: true }; // no verb seen — default read
}

// ---------------------------------------------------------------------------
// Rust detection
// ---------------------------------------------------------------------------

function detectRust(lines: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('//')) continue; // comment / doc comment

    for (const m of line.matchAll(RUST_REST)) {
      const verb = nearestRustVerb(lines, i);
      let direction: EdgeDirection;
      let ambiguous = false;
      if (verb) {
        direction = verb;
      } else if (line.includes('select=')) {
        direction = 'read'; // PostgREST select query
      } else {
        direction = 'read';
        ambiguous = true;
      }
      out.push({ table: m[1], line: i + 1, direction, ambiguous });
    }
  }
  return out;
}

// Nearest HTTP verb to the URL line, searching forward further than backward
// (the URL is usually built just before the verb call).
function nearestRustVerb(lines: string[], i: number): EdgeDirection | null {
  for (let d = 0; d <= RUST_LOOK_FWD; d++) {
    const candidates = d === 0 ? [i] : d <= RUST_LOOK_BACK ? [i + d, i - d] : [i + d];
    for (const j of candidates) {
      if (j < 0 || j >= lines.length) continue;
      if (RUST_WRITE_VERB.test(lines[j])) return 'write';
      if (RUST_READ_VERB.test(lines[j])) return 'read';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Notes / file discovery / helpers
// ---------------------------------------------------------------------------

function buildNotes(lang: Language, direction: EdgeDirection, table: string): string {
  const name = lang === 'rust' ? 'Rust' : 'Python';
  const tail = direction === 'write' ? ', manually kept aligned — dark.' : ' — dark.';
  return `${name} ${direction} of \`${table}\` (shallow grep) — no shared schema type${tail}`;
}

async function walkSourceFiles(repoPath: string): Promise<string[]> {
  const out: string[] = [];
  await walk(repoPath, out);
  out.sort();
  return out;
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(full, out);
    } else if (entry.isFile() && (entry.name.endsWith('.py') || entry.name.endsWith('.rs'))) {
      out.push(full);
    }
  }
}

function tally<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function tableCounts(nodes: GraphNode[], lang: Language): Record<string, number> {
  const counts = tally(
    nodes.filter((n) => n.language === lang),
    (n) => n.label.split(' ').slice(1).join(' '),
  );
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}
