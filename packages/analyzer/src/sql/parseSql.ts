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
import type { ContractColumn, GraphNode, Relationship, SourceRef, SqlViewRead } from '@throughline/core';

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
  return (await parseSchema(repoPath)).nodes;
}

// FK-A1 (ADDITIVE): one pass over the migrations yielding both the contract nodes
// and the DECLARED foreign-key relationships between them. `parseSql` is now a
// thin wrapper that drops the relationships, so every existing caller is
// unaffected; callers that want the connection layer use this instead.
export interface Schema {
  nodes: GraphNode[];
  relationships: Relationship[];
  sqlViewReads: SqlViewRead[];
}

export async function parseSchema(repoPath: string): Promise<Schema> {
  const files = await findSqlFiles(repoPath);
  // Lexical by filename (Supabase prefixes timestamps, so this is chronological),
  // full path as a stable tie-breaker.
  files.sort((a, b) => cmp(path.basename(a), path.basename(b)) || cmp(a, b));

  const tables = new Map<string, TableAcc>();
  const rawFks: RawFk[] = [];
  const sqlViewReads: SqlViewRead[] = [];
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
        const ctx: ParseCtx = { rel, basename, chunk, lineAt, tables, rawFks, sqlViewReads, note };
        applyStatement(stmt, ctx);
      }
    }
  }

  const nodes = [...tables.values()].map(toContractNode);
  const relationships = resolveRelationships(rawFks, tables);

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
          relationships: relationships.length,
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

  return { nodes, relationships, sqlViewReads };
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
  // FK-A1: single-column identity constraints, accumulated across migrations.
  // Used ONLY to infer cardinality: a single-column UNIQUE or PK on the FK column
  // makes the relationship one-to-one. Composite keys are deliberately NOT
  // recorded here — a column inside a composite key is not individually unique.
  uniqueColumns: Set<string>; // columns carrying a single-column UNIQUE or PK
}

// FK-A1: a declared foreign key as collected during the pass, before targets are
// resolved. `foreignColumns` may be empty (`REFERENCES target` with no column),
// in which case it resolves to the target's PK at the end of the pass.
interface RawFk {
  fromTable: string;
  localColumns: string[];
  toTable: string;
  foreignColumns: string[];
  source: SourceRef;
}

interface ParseCtx {
  rel: string;
  basename: string;
  chunk: Statement_Chunk;
  lineAt: (offset: number) => number;
  tables: Map<string, TableAcc>;
  rawFks: RawFk[];
  sqlViewReads: SqlViewRead[];
  note: (reason: string) => void;
}

function applyStatement(stmt: Statement, ctx: ParseCtx): void {
  if (stmt.type === 'create table') {
    handleCreate(stmt, ctx);
  } else if (stmt.type === 'alter table') {
    handleAlter(stmt, ctx);
  } else if (stmt.type === 'create view') {
    handleCreateView(stmt as CreateViewStatement, ctx);
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
  const uniqueColumns = new Set<string>();
  const columns = new Map<string, ContractColumn>();
  const source = sourceFrom(ctx);

  for (const def of stmt.columns) {
    if (def.kind !== 'column') continue; // skip `LIKE other_table`
    const col = buildColumn(def, pkColumns);
    columns.set(col.name, col);

    // Column-level identity + FK declarations.
    for (const c of def.constraints ?? []) {
      if (c.type === 'unique' || c.type === 'primary key') uniqueColumns.add(col.name);
      if (c.type === 'reference') {
        ctx.rawFks.push({
          fromTable: name,
          localColumns: [col.name],
          toTable: c.foreignTable.name,
          foreignColumns: c.foreignColumns.map((fc) => fc.name),
          source,
        });
      }
    }
  }

  // Table-level constraints: single-column UNIQUE/PK feed cardinality; FOREIGN KEY
  // constraints are real declared relationships.
  for (const constraint of stmt.constraints ?? []) {
    if (constraint.type === 'unique' || constraint.type === 'primary key') {
      if (constraint.columns.length === 1) uniqueColumns.add(constraint.columns[0].name);
    } else if (constraint.type === 'foreign key') {
      ctx.rawFks.push({
        fromTable: name,
        localColumns: constraint.localColumns.map((lc) => lc.name),
        toTable: constraint.foreignTable.name,
        foreignColumns: constraint.foreignColumns.map((fc) => fc.name),
        source,
      });
    }
  }

  // A single-column PK is also a unique column for cardinality purposes.
  if (pkColumns.size === 1) for (const c of pkColumns) uniqueColumns.add(c);

  ctx.tables.set(name, {
    name,
    columns,
    source,
    createdInFile: ctx.basename,
    extendedIn: new Set(),
    uniqueColumns,
  });
}

function handleAlter(stmt: AlterTableStatement, ctx: ParseCtx): void {
  const name = stmt.table.name;
  const table = ctx.tables.get(name);
  let changedColumns = false;
  let handledFk = false;

  for (const change of stmt.changes) {
    if (change.type === 'add column') {
      if (!table) continue;
      const col = buildColumn(change.column, new Set());
      table.columns.set(col.name, col);
      changedColumns = true;
      // An added column can itself carry identity + FK constraints.
      for (const c of change.column.constraints ?? []) {
        if (c.type === 'unique' || c.type === 'primary key') table.uniqueColumns.add(col.name);
        if (c.type === 'reference') {
          ctx.rawFks.push({
            fromTable: name,
            localColumns: [col.name],
            toTable: c.foreignTable.name,
            foreignColumns: c.foreignColumns.map((fc) => fc.name),
            source: sourceFrom(ctx),
          });
          handledFk = true;
        }
      }
    } else if (change.type === 'drop column') {
      if (!table) continue;
      table.columns.delete(change.column.name);
      changedColumns = true;
    } else if (change.type === 'add constraint') {
      const constraint = change.constraint;
      if (constraint.type === 'foreign key') {
        ctx.rawFks.push({
          fromTable: name,
          localColumns: constraint.localColumns.map((lc) => lc.name),
          toTable: constraint.foreignTable.name,
          foreignColumns: constraint.foreignColumns.map((fc) => fc.name),
          source: sourceFrom(ctx),
        });
        handledFk = true;
      } else if (
        table &&
        (constraint.type === 'unique' || constraint.type === 'primary key') &&
        constraint.columns.length === 1
      ) {
        // A later single-column UNIQUE/PK can flip an FK column to one-to-one.
        table.uniqueColumns.add(constraint.columns[0].name);
      }
    }
  }

  if (changedColumns && table) {
    if (ctx.basename !== table.createdInFile) table.extendedIn.add(ctx.basename);
  } else if (!handledFk) {
    // ALTER with no column add/drop and no FK we extracted (RLS enable, owner,
    // rename, check constraints, ...).
    const kinds = stmt.changes.map((c) => c.type).join(', ') || 'no-op';
    ctx.note(`alter table (${kinds})`);
  }
}

// ---------------------------------------------------------------------------
// SQL view read accumulation
// ---------------------------------------------------------------------------

type AnyNode = Record<string, unknown>;
type CreateViewStatement = Statement & {
  type: 'create view';
  name: { name: string };
  query: unknown;
};
type SelectFromItem = {
  type?: string;
  name?: { name: string; alias?: string };
};
type SimpleSelectStatement = {
  type: 'select';
  columns?: { expr?: unknown }[];
  from?: SelectFromItem[];
};

function handleCreateView(stmt: CreateViewStatement, ctx: ParseCtx): void {
  const source = sourceFrom(ctx);
  const viewName = stmt.name.name;
  const reads = readsFromViewQuery(viewName, stmt.query, ctx.tables, source);
  if (reads.length === 0) {
    ctx.note('create view (no attributable table read)');
    return;
  }
  ctx.sqlViewReads.push(...reads);
}

function readsFromViewQuery(
  viewName: string,
  query: unknown,
  tables: Map<string, TableAcc>,
  source: SourceRef,
): SqlViewRead[] {
  if (isSelect(query)) return readsFromSelect(viewName, query, tables, source);

  // CTEs and nested query shapes can read real base tables while obscuring which
  // final view columns came from which base columns. Keep the table-level reader
  // as opaque evidence rather than inventing column precision.
  return [...collectKnownTableRefs(query, tables)]
    .sort()
    .map((table) => opaqueViewRead(viewName, table, source));
}

function readsFromSelect(
  viewName: string,
  query: SimpleSelectStatement,
  tables: Map<string, TableAcc>,
  source: SourceRef,
): SqlViewRead[] {
  const aliases = tableAliases(query, tables);
  if (aliases.size === 0) return [];

  const certain = new Map<string, Set<string>>();
  const opaque = new Set<string>();
  const addCol = (table: string, column: string) => {
    const acc = tables.get(table);
    if (!acc?.columns.has(column)) return;
    const cols = certain.get(table) ?? new Set<string>();
    cols.add(column);
    certain.set(table, cols);
  };
  const addAll = (table: string) => {
    const acc = tables.get(table);
    if (!acc) return;
    certain.set(table, new Set(acc.columns.keys()));
  };

  for (const col of query.columns ?? []) {
    const expr = (col as { expr?: unknown }).expr;
    if (!isRef(expr)) {
      addExpressionRefs(expr, aliases, tables, addCol, opaque);
      continue;
    }

    const name = stringProp(expr, 'name');
    const qualifier = refTableName(expr);
    if (name === '*') {
      if (qualifier) {
        const table = aliases.get(qualifier);
        if (table) addAll(table);
      } else if (uniqueAliasTargets(aliases).length === 1) {
        addAll(uniqueAliasTargets(aliases)[0]);
      } else {
        for (const table of uniqueAliasTargets(aliases)) opaque.add(table);
      }
      continue;
    }

    if (qualifier) {
      const table = aliases.get(qualifier);
      if (table) addCol(table, name);
      continue;
    }

    const possible = [...new Set(aliases.values())].filter((table) => tables.get(table)?.columns.has(name));
    if (possible.length === 1) {
      addCol(possible[0], name);
    } else {
      for (const table of possible) opaque.add(table);
    }
  }

  addExpressionRefs(query.from, aliases, tables, addCol, opaque);
  addExpressionRefs((query as AnyNode).where, aliases, tables, addCol, opaque);

  return [
    ...[...certain.entries()]
      .filter(([, cols]) => cols.size > 0)
      .map(([table, cols]) => ({
        viewName,
        table,
        confidence: 'certain' as const,
        columns: [...cols],
        source,
        note: `SQL view \`${viewName}\` reads these columns.`,
      })),
    ...[...opaque].sort().map((table) => opaqueViewRead(viewName, table, source)),
  ];
}

function addExpressionRefs(
  node: unknown,
  aliases: Map<string, string>,
  tables: Map<string, TableAcc>,
  addCol: (table: string, column: string) => void,
  opaque: Set<string>,
) {
  for (const ref of collectRefs(node)) {
    const name = stringProp(ref, 'name');
    if (!name || name === '*') continue;
    const qualifier = refTableName(ref);
    if (qualifier) {
      const table = aliases.get(qualifier);
      if (table) addCol(table, name);
      continue;
    }
    const possible = [...new Set(aliases.values())].filter((table) => tables.get(table)?.columns.has(name));
    if (possible.length === 1) addCol(possible[0], name);
    else for (const table of possible) opaque.add(table);
  }
}

function collectRefs(node: unknown): AnyNode[] {
  const refs: AnyNode[] = [];
  const visit = (cur: unknown) => {
    if (!cur || typeof cur !== 'object') return;
    const obj = cur as AnyNode;
    if (obj.type === 'ref') refs.push(obj);
    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) for (const item of value) visit(item);
      else visit(value);
    }
  };
  visit(node);
  return refs;
}

function tableAliases(query: SimpleSelectStatement, tables: Map<string, TableAcc>): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const item of (query.from ?? []) as SelectFromItem[]) {
    if (item.type !== 'table' || !item.name) continue;
    const table = item.name.name;
    if (!tables.has(table)) continue;
    aliases.set(table, table);
    if (item.name.alias) aliases.set(item.name.alias, table);
  }
  return aliases;
}

function uniqueAliasTargets(aliases: Map<string, string>): string[] {
  return [...new Set(aliases.values())];
}

function opaqueViewRead(viewName: string, table: string, source: SourceRef): SqlViewRead {
  return {
    viewName,
    table,
    confidence: 'opaque',
    source,
    note: `SQL view \`${viewName}\` reads \`${table}\`, but Throughline could not attribute columns.`,
  };
}

function collectKnownTableRefs(
  node: unknown,
  tables: Map<string, TableAcc>,
  aliases: Map<string, string> = new Map(),
): Set<string> {
  const out = new Set<string>();
  const visit = (cur: unknown) => {
    if (!cur || typeof cur !== 'object') return;
    const obj = cur as AnyNode;

    if (obj.type === 'table' && isName(obj.name)) {
      const table = obj.name.name;
      if (tables.has(table)) out.add(table);
    }
    if (obj.type === 'ref') {
      const table = refTableName(obj);
      if (table) {
        const resolved = aliases.get(table) ?? table;
        if (tables.has(resolved)) out.add(resolved);
      }
    }

    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) for (const item of value) visit(item);
      else visit(value);
    }
  };
  visit(node);
  return out;
}

function isSelect(node: unknown): node is SimpleSelectStatement {
  return (
    !!node &&
    typeof node === 'object' &&
    (node as { type?: unknown }).type === 'select' &&
    Array.isArray((node as { columns?: unknown }).columns)
  );
}

function isRef(node: unknown): node is AnyNode {
  return !!node && typeof node === 'object' && (node as { type?: unknown }).type === 'ref';
}

function isName(node: unknown): node is { name: string; alias?: string } {
  return !!node && typeof node === 'object' && typeof (node as { name?: unknown }).name === 'string';
}

function refTableName(ref: AnyNode): string | undefined {
  const table = ref.table;
  return isName(table) ? table.name : undefined;
}

function stringProp(obj: AnyNode, key: string): string {
  const value = obj[key];
  return typeof value === 'string' ? value : '';
}

// FK-A1: turn the raw FK declarations into Relationships once every table is
// known. Pure resolution of facts already collected — NO inference. One
// Relationship per column pair. Cardinality is one-to-one ONLY for a
// single-column FK whose column is itself UNIQUE or the PK in the source table;
// everything else stays many-to-one. (The common parser rejects `REFERENCES
// target` without a column list, so `foreignColumns` is always populated for FKs
// we actually extract; the `?? ''` is a defensive guard against arity mismatch,
// never a fabricated column.)
function resolveRelationships(rawFks: RawFk[], tables: Map<string, TableAcc>): Relationship[] {
  const out: Relationship[] = [];
  for (const fk of rawFks) {
    const sourceTable = tables.get(fk.fromTable);
    const singleColumn = fk.localColumns.length === 1;

    for (let i = 0; i < fk.localColumns.length; i++) {
      const fromColumn = fk.localColumns[i];
      const isUnique = singleColumn && !!sourceTable && sourceTable.uniqueColumns.has(fromColumn);
      out.push({
        fromTable: fk.fromTable,
        fromColumn,
        toTable: fk.toTable,
        toColumn: fk.foreignColumns[i] ?? '',
        cardinality: isUnique ? 'one-to-one' : 'many-to-one',
        source: fk.source,
      });
    }
  }
  return out;
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
