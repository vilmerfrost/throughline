import { readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import {
  parse,
  toSql,
  type AlterTableStatement,
  type CreateColumnDef,
  type CreateTableStatement,
  type DataTypeDef,
  type Statement,
} from 'pgsql-ast-parser';
import type { ContractColumn, GraphNode, SourceRef } from '@throughline/core';

// Where Supabase keeps migrations. Change this one line to point elsewhere; the
// directory we scan is the part of the glob before the wildcard.
const MIGRATIONS_GLOB = 'supabase/migrations/**/*.sql';
const MIGRATIONS_DIR = MIGRATIONS_GLOB.split('/**')[0]; // 'supabase/migrations'

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'target',
  'vendor',
  '.turbo',
]);

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

// Parse the repo's SQL migrations into one `contract` node per table. Migrations
// are cumulative and order-dependent, so we apply CREATE / ALTER ... ADD COLUMN
// / ALTER ... DROP COLUMN in lexical filename order; the final node reflects the
// schema after every migration has been applied. Every node is grounded in the
// real CREATE TABLE statement that defined it. Anything that isn't table DDL is
// skipped (and counted), never fabricated.
export async function parseSql(repoPath: string): Promise<GraphNode[]> {
  const files = await findSqlFiles(repoPath);
  // Lexical by filename (Supabase prefixes timestamps, so this is chronological),
  // full path as a stable tie-breaker.
  files.sort((a, b) => cmp(path.basename(a), path.basename(b)) || cmp(a, b));

  const tables = new Map<string, TableAcc>();
  const skipReasons = new Map<string, number>();
  let skipped = 0;
  const note = (reason: string) => {
    skipped += 1;
    skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
  };

  for (const file of files) {
    const rel = path.relative(repoPath, file);
    const basename = path.basename(file);
    const content = await readFile(file, 'utf8');
    const lineAt = makeLineLookup(content);

    for (const chunk of splitStatements(content)) {
      if (!chunk.text.trim()) continue;

      let statements: Statement[];
      try {
        statements = parse(chunk.text);
      } catch (err) {
        // RLS policies, triggers, functions, grants, etc. that this parser does
        // not understand land here. Never let one statement crash the run.
        note(`parse error: ${shortError(err)}`);
        continue;
      }

      for (const stmt of statements) {
        const ctx: ParseCtx = { rel, basename, chunk, lineAt, tables, note };
        applyStatement(stmt, ctx);
      }
    }
  }

  const nodes = [...tables.values()].map(toContractNode);

  if (process.env.THROUGHLINE_SQL_DEBUG) {
    const totalColumns = nodes.reduce((sum, n) => sum + (n.columns?.length ?? 0), 0);
    console.error(
      JSON.stringify(
        {
          repoPath,
          files: files.length,
          tables: nodes.length,
          tableNames: nodes.map((n) => n.label),
          totalColumns,
          skipped,
          skipReasons: Object.fromEntries(
            [...skipReasons.entries()].sort((a, b) => b[1] - a[1]),
          ),
        },
        null,
        2,
      ),
    );
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Schema accumulation
// ---------------------------------------------------------------------------

interface TableAcc {
  name: string;
  columns: Map<string, ContractColumn>; // insertion order = column order
  source: SourceRef; // points at the CREATE TABLE statement
  createdInFile: string; // basename of the migration that created it
  extendedIn: Set<string>; // basenames of later migrations that altered its columns
}

interface ParseCtx {
  rel: string;
  basename: string;
  chunk: Statement_Chunk;
  lineAt: (offset: number) => number;
  tables: Map<string, TableAcc>;
  note: (reason: string) => void;
}

function applyStatement(stmt: Statement, ctx: ParseCtx): void {
  if (stmt.type === 'create table') {
    handleCreate(stmt, ctx);
  } else if (stmt.type === 'alter table') {
    handleAlter(stmt, ctx);
  } else {
    ctx.note(stmt.type);
  }
}

function handleCreate(stmt: CreateTableStatement, ctx: ParseCtx): void {
  const name = stmt.name.name;

  // CREATE (incl. IF NOT EXISTS) on a table we already have: keep the original
  // definition and source, do not redefine.
  if (ctx.tables.has(name)) return;

  const pkColumns = collectPrimaryKeyColumns(stmt);
  const columns = new Map<string, ContractColumn>();
  for (const def of stmt.columns) {
    if (def.kind !== 'column') continue; // skip `LIKE other_table`
    const col = buildColumn(def, pkColumns);
    columns.set(col.name, col);
  }

  ctx.tables.set(name, {
    name,
    columns,
    source: sourceFrom(ctx),
    createdInFile: ctx.basename,
    extendedIn: new Set(),
  });
}

function handleAlter(stmt: AlterTableStatement, ctx: ParseCtx): void {
  const name = stmt.table.name;
  const table = ctx.tables.get(name);
  let changedColumns = false;

  for (const change of stmt.changes) {
    if (change.type === 'add column') {
      if (!table) continue;
      const col = buildColumn(change.column, new Set());
      table.columns.set(col.name, col);
      changedColumns = true;
    } else if (change.type === 'drop column') {
      if (!table) continue;
      table.columns.delete(change.column.name);
      changedColumns = true;
    }
  }

  if (changedColumns && table) {
    if (ctx.basename !== table.createdInFile) table.extendedIn.add(ctx.basename);
  } else {
    // ALTER with no column add/drop (constraints, RLS enable, owner, rename, ...)
    const kinds = stmt.changes.map((c) => c.type).join(', ') || 'no-op';
    ctx.note(`alter table (${kinds})`);
  }
}

function collectPrimaryKeyColumns(stmt: CreateTableStatement): Set<string> {
  const pk = new Set<string>();
  for (const constraint of stmt.constraints ?? []) {
    if (constraint.type === 'primary key') {
      for (const col of constraint.columns) pk.add(col.name);
    }
  }
  return pk;
}

function buildColumn(def: CreateColumnDef, pkColumns: Set<string>): ContractColumn {
  const name = def.name.name;
  let notNull = pkColumns.has(name);
  let hasDefault = false;
  for (const c of def.constraints ?? []) {
    if (c.type === 'not null' || c.type === 'primary key') notNull = true;
    // A DEFAULT (incl. on a PK, e.g. `default gen_random_uuid()`) makes the
    // column OPTIONAL on insert — Postgres fills it — even when NOT NULL.
    if (c.type === 'default') hasDefault = true;
  }
  return { name, type: renderType(def.dataType), nullable: !notNull, hasDefault };
}

function toContractNode(t: TableAcc): GraphNode {
  const columns = [...t.columns.values()];
  const extended = t.extendedIn.size;
  const notes =
    `Table \`${t.name}\` — ${columns.length} ${plural(columns.length, 'column')}. ` +
    `Defined in ${t.createdInFile}` +
    (extended > 0
      ? `, extended in ${extended} later ${plural(extended, 'migration')}.`
      : '.');

  return {
    id: `contract:${t.name}`,
    kind: 'contract',
    label: t.name,
    language: 'sql',
    columns,
    source: t.source,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Type rendering
// ---------------------------------------------------------------------------

function renderType(dt: DataTypeDef): string {
  try {
    const s = toSql.dataType(dt);
    if (s && s.trim()) return s.trim().replace(/\s+\[\]/g, '[]'); // "text []" -> "text[]"
  } catch {
    // fall through to manual rendering
  }
  return manualType(dt);
}

function manualType(dt: DataTypeDef): string {
  if (dt.kind === 'array') return `${manualType(dt.arrayOf)}[]`;
  let s = dt.name;
  if (dt.config && dt.config.length > 0) s += `(${dt.config.join(', ')})`;
  return s;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

async function findSqlFiles(repoPath: string): Promise<string[]> {
  const primary = await walkSql(path.join(repoPath, MIGRATIONS_DIR));
  if (primary.length > 0) return primary;

  // Fallback: any *.sql in the repo that actually contains a CREATE TABLE.
  const all = await walkSql(repoPath);
  const withCreateTable: string[] = [];
  for (const file of all) {
    const content = await readFile(file, 'utf8');
    if (/create\s+table/i.test(content)) withCreateTable.push(file);
  }
  return withCreateTable;
}

async function walkSql(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // directory does not exist or is unreadable
  }

  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await walkSql(full)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.sql')) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// SQL-aware statement splitting (so one bad statement can't kill a file) and
// offset -> line mapping (so SourceRefs point at the real lines).
// ---------------------------------------------------------------------------

interface Statement_Chunk {
  text: string; // the raw statement text (may include a leading comment)
  start: number; // offset of `text` within the file
}

function splitStatements(sql: string): Statement_Chunk[] {
  const out: Statement_Chunk[] = [];
  const n = sql.length;
  let i = 0;
  let chunkStart = 0;

  while (i < n) {
    const c = sql[i];

    // line comment
    if (c === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    // block comment
    if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // single-quoted string literal
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // double-quoted identifier
    if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // dollar-quoted string ($$ ... $$ or $tag$ ... $tag$) — e.g. function bodies
    if (c === '$') {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        continue;
      }
    }
    // statement terminator
    if (c === ';') {
      out.push({ text: sql.slice(chunkStart, i + 1), start: chunkStart });
      i++;
      chunkStart = i;
      continue;
    }
    i++;
  }

  if (chunkStart < n && sql.slice(chunkStart).trim()) {
    out.push({ text: sql.slice(chunkStart), start: chunkStart });
  }
  return out;
}

function makeLineLookup(sql: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === '\n') starts.push(i + 1);
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
    return ans + 1; // 1-based
  };
}

// Build the SourceRef for the current statement chunk, skipping any leading
// comments/whitespace so the location points at the statement itself.
function sourceFrom(ctx: ParseCtx): SourceRef {
  const { chunk, lineAt, rel } = ctx;
  const lead = leadingNoise(chunk.text);
  const startOffset = chunk.start + lead;
  const snippet = chunk.text.slice(lead).trimEnd();
  const endOffset = startOffset + Math.max(0, snippet.length - 1);
  return {
    language: 'sql',
    filePath: rel,
    startLine: lineAt(startOffset),
    endLine: lineAt(endOffset),
    snippet,
  };
}

// Length of leading whitespace and comments before the real statement starts.
function leadingNoise(text: string): number {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
    } else if (c === '-' && text[i + 1] === '-') {
      i += 2;
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
    } else {
      break;
    }
  }
  return i;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0].slice(0, 120);
}
