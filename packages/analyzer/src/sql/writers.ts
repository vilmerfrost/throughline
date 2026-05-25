import { readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type {
  EdgeDirection,
  GraphEdge,
  GraphNode,
  SourceRef,
  WriterLifecycle,
} from '@throughline/core';
import { classifySourceScope } from '../sourceScope.js';

// SQL writer pass — distinct from `parseSchema` (contracts) and from
// per-language touches. Scans `supabase/migrations/**/*.sql` for SQL statements
// that touch DATA (not DDL) and emits one touch node per statement.
//
// Three lifecycles get emitted, all grounded in real SQL lines:
//   migration — a top-level `INSERT INTO x ... / UPDATE x ... / DELETE FROM x`
//               inside a migration file. Distinct from app writers; they run
//               once per environment.
//   trigger   — an `INSERT/UPDATE/DELETE` *inside* a `CREATE OR REPLACE
//               FUNCTION ... AS $$ ... $$` body. The DB itself drives the write.
//   seed      — `INSERT INTO` inside `supabase/seed.sql` (or `supabase/seed*.sql`).
//
// All emitted touches are `dark` with `analysisDepth: 'shallow'`: we know the
// table + verb from real SQL, but the field-level claim would require a deep
// parse we don't do here. This is honest: the writer exists, but we make no
// per-column claim.

const MIGRATIONS_DIR = 'supabase/migrations';
const SEED_DIR_PREFIX = 'supabase/seed';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'target', 'vendor', '.turbo',
]);

// Top-level SQL DML at the start of a statement.
const DML = /\b(insert\s+into|update|delete\s+from)\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/gi;
// Function/trigger body delimiters. Postgres lets `$tag$ ... $tag$` carry any
// tag — we capture the opening tag and look for the matching close.
const DOLLAR_OPEN = /\$([A-Za-z0-9_]*)\$/g;

export interface SqlWriterResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export async function sqlWriters(
  repoPath: string,
  contracts: GraphNode[],
): Promise<SqlWriterResult> {
  const known = new Set(contracts.map((c) => c.label));
  const files = await walkSqlFiles(repoPath);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (const abs of files) {
    const rel = path.relative(repoPath, abs);
    const normalized = rel.split(path.sep).join('/');
    const defaultLifecycle = pickDefaultLifecycle(normalized);
    if (!defaultLifecycle) continue;

    let content: string;
    try {
      content = await readFile(abs, 'utf8');
    } catch {
      continue;
    }

    const searchable = maskSqlComments(content);
    const triggerSpans = collectTriggerBodySpans(searchable);
    const lineAt = makeLineLookup(content);
    const writes = detectWrites(searchable);

    for (const w of writes) {
      if (!known.has(w.table)) continue;
      const inTrigger = triggerSpans.some(([s, e]) => w.offset >= s && w.offset < e);
      const lifecycle: WriterLifecycle = inTrigger ? 'trigger' : defaultLifecycle;
      const line = lineAt(w.offset);
      const snippet = sliceSnippet(content, w.offset);

      const id = `touch:sql:${normalized}:${line}:${w.table}:${lifecycle}`;
      if (seen.has(id)) continue;
      seen.add(id);

      const source: SourceRef = {
        language: 'sql',
        filePath: normalized,
        startLine: line,
        endLine: line,
        snippet,
      };
      nodes.push({
        id,
        kind: 'touch',
        language: 'sql',
        label: `${w.direction} ${w.table}`,
        // Real SQL → the verb and table are KNOWN; columns are not yet parsed.
        // Trust is `dark` (no carried schema type) but the lifecycle says this
        // is NOT an app-runtime writer.
        trust: 'dark',
        trustReason: 'shallow-grep-sql',
        sourceScope: classifySourceScope(normalized),
        analysisDepth: 'shallow',
        lifecycle,
        source,
        notes: noteFor(lifecycle, w.direction, w.table),
      });
      edges.push({
        id: `edge:${id}`,
        source: id,
        target: `contract:${w.table}`,
        direction: w.direction,
      });
    }
  }

  return { nodes, edges };
}

function pickDefaultLifecycle(filePath: string): WriterLifecycle | undefined {
  if (filePath.startsWith(`${MIGRATIONS_DIR}/`)) return 'migration';
  if (filePath.startsWith(SEED_DIR_PREFIX) || /\/seed\.sql$/.test(filePath)) return 'seed';
  return undefined;
}

interface WriteHit {
  offset: number;
  direction: EdgeDirection;
  table: string;
}

function detectWrites(content: string): WriteHit[] {
  const out: WriteHit[] = [];
  DML.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = DML.exec(content)); ) {
    const verb = m[1].toLowerCase();
    out.push({
      offset: m.index,
      table: m[2],
      direction: verb.startsWith('insert') || verb.startsWith('update') || verb.startsWith('delete') ? 'write' : 'read',
    });
  }
  return out;
}

// Replace comments with spaces so regex offsets still point into the original
// content for line lookups and snippets. We intentionally do not parse SQL here;
// this is just enough masking to prevent false writer facts from prose/commented
// examples while preserving real statement grounding.
function maskSqlComments(content: string): string {
  let out = '';
  let i = 0;
  while (i < content.length) {
    const c = content[i];
    const next = content[i + 1];
    if (c === '-' && next === '-') {
      out += '  ';
      i += 2;
      while (i < content.length && content[i] !== '\n') {
        out += content[i] === '\r' ? '\r' : ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < content.length) {
        if (content[i] === '*' && content[i + 1] === '/') {
          out += '  ';
          i += 2;
          break;
        }
        out += content[i] === '\n' || content[i] === '\r' ? content[i] : ' ';
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// Return the [start, end) offsets of every `$tag$ ... $tag$` body in the file.
// We scan the OUTER bodies only (no nested $$ inside $tag$ tricks); good enough
// to mark trigger/function code so we can label those writes as `trigger`.
function collectTriggerBodySpans(content: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  DOLLAR_OPEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DOLLAR_OPEN.exec(content))) {
    const tag = m[0];
    const openEnd = m.index + tag.length;
    const closeIdx = content.indexOf(tag, openEnd);
    if (closeIdx === -1) break;
    spans.push([openEnd, closeIdx]);
    DOLLAR_OPEN.lastIndex = closeIdx + tag.length;
  }
  return spans;
}

function sliceSnippet(content: string, offset: number): string {
  const end = content.indexOf(';', offset);
  const stop = end === -1 ? Math.min(content.length, offset + 200) : end + 1;
  return content.slice(offset, stop).split('\n')[0].trim();
}

function noteFor(lifecycle: WriterLifecycle, direction: EdgeDirection, table: string): string {
  const verb = direction === 'write' ? 'write' : 'read';
  switch (lifecycle) {
    case 'migration':
      return `SQL migration ${verb} of \`${table}\` — runs once per environment, NOT a runtime app writer.`;
    case 'trigger':
      return `SQL trigger/function body ${verb} of \`${table}\` — fired by the database, NOT by app code.`;
    case 'seed':
      return `SQL seed ${verb} of \`${table}\` — one-off data load, NOT a runtime app writer.`;
    default:
      return `SQL ${verb} of \`${table}\`.`;
  }
}

function makeLineLookup(content: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') starts.push(i + 1);
  }
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= offset) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans + 1;
  };
}

async function walkSqlFiles(repoPath: string): Promise<string[]> {
  const out: string[] = [];
  await walk(path.join(repoPath, MIGRATIONS_DIR), out);
  await walk(path.join(repoPath, 'supabase'), out, /^seed.*\.sql$/i);
  out.sort();
  return out;
}

async function walk(dir: string, out: string[], onlyMatching?: RegExp): Promise<void> {
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
      await walk(full, out, onlyMatching);
    } else if (entry.isFile()) {
      const lower = entry.name.toLowerCase();
      if (!lower.endsWith('.sql')) continue;
      if (onlyMatching && !onlyMatching.test(entry.name)) continue;
      out.push(full);
    }
  }
}
