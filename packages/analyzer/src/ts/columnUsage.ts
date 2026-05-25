import path from 'node:path';
import {
  Node,
  SyntaxKind,
  type CallExpression,
  type Project,
  type SourceFile,
} from 'ts-morph';
import type { ColumnUsage, ColumnUsageVerdict, GraphNode, SourceRef, SqlViewRead } from '@throughline/core';
import { isTypedClient, loadProject } from './parseTs.js';
import { computeReach, type ReachResult } from './reach.js';
import { collectTableHelperAliases, findTableAccesses, type TableAccess } from './tableHelpers.js';

// ---------------------------------------------------------------------------
// Column-level read-usage analysis (TypeScript only).
//
// For each contract column we decide, from the TS reads of that contract, HOW
// the column is read — and we are scrupulously honest about confidence:
//
//   used            explicitly named in `.select('… col …')`           CERTAIN
//   likely_rendered select('*') result accessed inside JSX             heuristic
//   likely_used     select('*') result accessed in non-JSX code        heuristic
//   unknown         select('*') result escaped local scope             heuristic
//   likely_dead     reads stayed local, column never referenced        heuristic
//
// Hard rules (see the honesty checks in the verdict logic):
//   - certain === true ONLY for `used`.
//   - "rendered" means a property access literally inside JSX, nothing else.
//   - we NEVER call a column dead when a `select('*')` read escaped scope —
//     that becomes `unknown` (we genuinely cannot follow it).
//   - every verdict except a pure `likely_dead` carries real SourceRef evidence.
//
// Scope is deliberately tight: TS reads only, and a single-scope trace only.
// If a `*` result is passed to a call, returned, spread, stored via state, or
// aliased to an outer-scope variable, we stop and report `unknown` rather than
// guess. Cross-file tracing is a later upgrade.
// ---------------------------------------------------------------------------

// Shared with the reach tracer (reach.ts) so both passes agree on which files to
// skip, what counts as a write, and what a valid identifier looks like.
export const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete']);
export const EXCLUDE = /[/\\](node_modules|\.next|dist|out|build|\.turbo)[/\\]|\.d\.ts$/;
export const IDENT = /^[A-Za-z_$][\w$]*$/;
const MAX_EVIDENCE = 5;

type AccessKind = 'jsx' | 'code';

// Per-table aggregate, accumulated across every read of that table.
interface TableAcc {
  columns: Set<string>;
  explicit: Map<string, SourceRef[]>; // col -> select sites that name it
  sqlViewExplicit: Map<string, SourceRef[]>; // col -> SQL view sites that prove a DB-side read
  sqlViewNames: Map<string, Set<string>>; // col -> view names for notes
  sqlViewOpaque: SourceRef[]; // SQL view reads this table but columns are opaque
  starAccess: Map<string, { jsx: SourceRef[]; code: SourceRef[] }>; // col -> access sites
  starEscapes: SourceRef[]; // `*` reads whose result we could not follow
  starReadSites: SourceRef[]; // `*` reads we DID fully inspect (for likely_dead context)
  explicitReadCount: number;
  starReadCount: number;
}

// Returns a map of table name -> per-column usage verdicts. Only tables present
// in `contracts` are analyzed; the caller attaches each list to its contract node.
export function computeColumnUsage(
  repoPath: string,
  contracts: GraphNode[],
  project: Project = loadProject(repoPath),
  sqlViewReads: SqlViewRead[] = [],
): Map<string, ColumnUsage[]> {
  const tables = new Map<string, TableAcc>();
  for (const c of contracts) {
    if (!c.columns || c.columns.length === 0) continue;
    tables.set(c.label, {
      columns: new Set(c.columns.map((col) => col.name)),
      explicit: new Map(),
      sqlViewExplicit: new Map(),
      sqlViewNames: new Map(),
      sqlViewOpaque: [],
      starAccess: new Map(),
      starEscapes: [],
      starReadSites: [],
      explicitReadCount: 0,
      starReadCount: 0,
    });
  }
  if (tables.size === 0) return new Map();

  applySqlViewUsage(tables, sqlViewReads);
  const helperAliases = collectTableHelperAliases(
    project,
    repoPath,
    new Set(tables.keys()),
    isTypedClient,
    resolveTableArg,
  );

  for (const sf of project.getSourceFiles()) {
    if (EXCLUDE.test(sf.getFilePath())) continue;
    try {
      for (const access of findTableAccesses(sf, helperAliases, resolveTableArg)) {
        const acc = tables.get(access.table);
        if (!acc) continue; // not a contract we know
        analyzeRead(access, acc, repoPath, sf);
      }
    } catch {
      // A malformed file must never sink the whole analysis; skip it.
    }
  }

  // The reach axis (B1): WHERE each column's value travels, traced cross-file via
  // findReferences. Computed in a separate pass that shares this same Project.
  const reachByTable = computeReach(repoPath, contracts, project, sqlViewReads);

  const out = new Map<string, ColumnUsage[]>();
  for (const [table, acc] of tables) {
    const reachMap = reachByTable.get(table);
    const usages: ColumnUsage[] = [];
    for (const col of acc.columns) usages.push(verdictFor(col, table, acc, reachMap?.get(col)));
    out.set(table, usages);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-read analysis: classify one `.from('table')…` chain.
// ---------------------------------------------------------------------------

function analyzeRead(access: TableAccess, acc: TableAcc, repoPath: string, sf: SourceFile) {
  const chain = walkChain(access.rootCall);
  if (chain.isWrite) return; // reads only

  if (chain.explicitColumns) {
    if (!access.alias && isBareReturnedBuilder(access.rootCall, chain)) return;
    // EXPLICIT SELECT — these columns are CERTAIN. Explicit beats everything.
    acc.explicitReadCount += 1;
    const site = refFrom(chain.selectCall ?? access.rootCall, repoPath, sf);
    for (const col of chain.explicitColumns) {
      if (!acc.columns.has(col)) continue;
      push(acc.explicit, col, site);
    }
    return;
  }

  // Otherwise this is a `select('*')` (or no/`*` select) read.
  if (!access.alias && isBareReturnedBuilder(access.rootCall, chain)) return;
  acc.starReadCount += 1;
  const rows = resolveRows(chain);

  if (rows.kind === 'directAccess') {
    // `const { data: { id, name } } = await …` — columns destructured straight off.
    acc.starReadSites.push(refFrom(access.rootCall, repoPath, sf));
    for (const a of rows.accesses) {
      if (acc.columns.has(a.column)) recordAccess(acc, a.column, 'code', refFrom(a.ref, repoPath, sf));
    }
    return;
  }
  if (rows.kind === 'escaped') {
    acc.starEscapes.push(refFrom(rows.ref ?? access.rootCall, repoPath, sf));
    return;
  }
  if (rows.kind === 'dead') {
    // result fetched but never bound/used — real evidence of a wasted `*` read.
    acc.starReadSites.push(refFrom(access.rootCall, repoPath, sf));
    return;
  }

  // rows.kind === 'var' — scan the local scope for property access on the var.
  acc.starReadSites.push(refFrom(access.rootCall, repoPath, sf));
  const { accesses, escaped, escapeRef } = scanRowsVar(rows.ident, rows.declId, rows.scope, acc.columns);
  for (const a of accesses) recordAccess(acc, a.column, a.kind, refFrom(a.node, repoPath, sf));
  if (escaped) acc.starEscapes.push(escapeRef ? refFrom(escapeRef, repoPath, sf) : refFrom(access.rootCall, repoPath, sf));
}

// ---------------------------------------------------------------------------
// Verdict combination (highest confidence wins).
// ---------------------------------------------------------------------------

function verdictFor(col: string, table: string, acc: TableAcc, reach?: ReachResult): ColumnUsage {
  // The reach axis is computed independently; if the tracer never saw a read of
  // this column it isn't in the map, which from reach's view means `never_read`.
  const r: ReachResult = reach ?? { reach: 'never_read' };
  const make = (
    verdict: ColumnUsageVerdict,
    certain: boolean,
    evidence: SourceRef[],
    note: string,
  ): ColumnUsage => ({
    column: col,
    verdict,
    certain,
    evidence: evidence.slice(0, MAX_EVIDENCE),
    note,
    reach: r.reach,
    ...(r.escapeTrail && r.escapeTrail.length > 0 ? { escapeTrail: r.escapeTrail.slice(0, MAX_EVIDENCE) } : {}),
  });

  // 1. EXPLICIT — fact.
  const explicit = acc.explicit.get(col);
  if (explicit && explicit.length > 0) {
    return make('used', true, explicit, `selected by name in ${explicit.length} read(s) — certain.`);
  }

  const sqlExplicit = acc.sqlViewExplicit.get(col);
  if (sqlExplicit && sqlExplicit.length > 0) {
    const views = [...(acc.sqlViewNames.get(col) ?? [])].sort();
    return make(
      'used',
      true,
      sqlExplicit,
      `read by SQL view${views.length === 1 ? '' : 's'} ${views.map((v) => `\`${v}\``).join(', ')} — certain DB-side read.`,
    );
  }

  // 2. select('*') accesses found locally.
  const star = acc.starAccess.get(col);
  if (star && star.jsx.length > 0) {
    return make(
      'likely_rendered',
      false,
      star.jsx,
      `accessed inside JSX in ${star.jsx.length} place(s) via \`select('*')\` (heuristic: local-scope property access).`,
    );
  }
  if (star && star.code.length > 0) {
    return make(
      'likely_used',
      false,
      star.code,
      `accessed in ${star.code.length} place(s) via \`select('*')\` (heuristic: local-scope property access).`,
    );
  }

  // 3. A `*` read escaped scope — we must NOT call this dead.
  if (acc.starEscapes.length > 0) {
    return make(
      'unknown',
      false,
      acc.starEscapes,
      `read via \`select('*')\` whose result escaped local scope in ${acc.starEscapes.length} read(s) — cannot trace (heuristic).`,
    );
  }

  if (acc.sqlViewOpaque.length > 0) {
    return make(
      'unknown',
      false,
      acc.sqlViewOpaque,
      `read by ${acc.sqlViewOpaque.length} SQL view(s), but exact columns could not be attributed — cannot call this unread (heuristic).`,
    );
  }

  // 4. Reads stayed local / were explicit, column never appeared → likely dead.
  if (acc.starReadCount > 0) {
    return make(
      'likely_dead',
      false,
      acc.starReadSites,
      `read via \`select('*')\` in ${acc.starReadSites.length} place(s) but this column is never accessed in local scope (heuristic).`,
    );
  }
  if (acc.explicitReadCount > 0) {
    const sites = [...acc.explicit.values()].flat();
    return make(
      'likely_dead',
      false,
      sites,
      `never named across ${acc.explicitReadCount} explicit \`select(...)\` read(s); no \`select('*')\` read (heuristic).`,
    );
  }

  // 5. No TS read of this table at all. Honest floor: from TS's view it isn't
  // read (other languages are out of scope here).
  return make('likely_dead', false, [], `no TypeScript read of \`${table}\` found (heuristic; other languages not analyzed).`);
}

function applySqlViewUsage(tables: Map<string, TableAcc>, sqlViewReads: SqlViewRead[]) {
  for (const read of sqlViewReads) {
    const acc = tables.get(read.table);
    if (!acc) continue;
    if (read.confidence === 'certain') {
      for (const col of read.columns ?? []) {
        if (!acc.columns.has(col)) continue;
        push(acc.sqlViewExplicit, col, read.source);
        const names = acc.sqlViewNames.get(col) ?? new Set<string>();
        names.add(read.viewName);
        acc.sqlViewNames.set(col, names);
      }
    } else {
      acc.sqlViewOpaque.push(read.source);
    }
  }
}

function recordAccess(acc: TableAcc, col: string, kind: AccessKind, ref: SourceRef) {
  let slot = acc.starAccess.get(col);
  if (!slot) {
    slot = { jsx: [], code: [] };
    acc.starAccess.set(col, slot);
  }
  (kind === 'jsx' ? slot.jsx : slot.code).push(ref);
}

function push(map: Map<string, SourceRef[]>, key: string, ref: SourceRef) {
  const arr = map.get(key);
  if (arr) arr.push(ref);
  else map.set(key, [ref]);
}

// ---------------------------------------------------------------------------
// Chain walking: direction + which columns (if any) the select names.
// ---------------------------------------------------------------------------

export interface ChainInfo {
  isWrite: boolean;
  explicitColumns: string[] | null; // null === a `*`/empty/absent select
  selectCall: CallExpression | null; // the `.select(...)` call, for evidence
  outerCall: CallExpression; // outermost call in the fluent chain
  thenCallback: Node | null; // first arg of a trailing `.then(cb)`, if any
  single: boolean; // a `.single()`/`.maybeSingle()` in the chain → result is one row, not an array
}

export function walkChain(fromCall: CallExpression): ChainInfo {
  const methods: string[] = [];
  let explicitColumns: string[] | null = null;
  let sawStar = false;
  let selectCall: CallExpression | null = null;
  let thenCallback: Node | null = null;
  let single = false;
  let outerCall: CallExpression = fromCall;

  let current: Node = fromCall;
  for (;;) {
    const parent = current.getParent();
    if (!parent || !Node.isPropertyAccessExpression(parent) || parent.getExpression() !== current) break;
    const grandparent = parent.getParent();
    if (!grandparent || !Node.isCallExpression(grandparent) || grandparent.getExpression() !== parent) break;

    const method = parent.getName();
    methods.push(method);
    if (method === 'select') {
      const cols = parseSelectArg(grandparent.getArguments()[0]);
      if (cols === '*') {
        sawStar = true;
      } else if (cols.length > 0 && explicitColumns === null) {
        explicitColumns = cols;
        selectCall = grandparent;
      }
    } else if (method === 'then') {
      thenCallback = grandparent.getArguments()[0] ?? null;
    } else if (method === 'single' || method === 'maybeSingle') {
      single = true;
    }
    outerCall = grandparent;
    current = grandparent;
  }

  const isWrite = methods.some((m) => WRITE_METHODS.has(m));
  // A concrete select wins; `*`, an empty/dynamic select, or no select at all
  // all leave explicitColumns === null, which downstream treats as a star read.
  void sawStar;
  return { isWrite, explicitColumns, selectCall, outerCall, thenCallback, single };
}

// Parse a `.select(arg)` first argument into real column names.
//   - returns '*' for `select()`, `select('*')`, or anything we treat as full.
//   - handles `alias:col`, bare `col`, and `col::cast`.
//   - skips embedded-relation syntax containing parentheses (v1).
export function parseSelectArg(arg: Node | undefined): string[] | '*' {
  if (!arg) return '*';
  const lit = literalString(arg);
  if (lit === undefined) return '*'; // dynamic select — treat as full read
  const text = lit.trim();
  if (text === '' || text === '*') return '*';

  const cols: string[] = [];
  for (const rawToken of text.split(',')) {
    let token = rawToken.trim();
    if (token === '' || token === '*') continue;
    if (token.includes('(') || token.includes(')')) continue; // embedded relation
    // `alias:target` — the real column is the target (right of a single colon,
    // not the `::` cast operator).
    const aliasMatch = token.match(/^[\w$]+:(?!:)(.+)$/);
    if (aliasMatch) token = aliasMatch[1].trim();
    // strip a `::cast`
    const castIdx = token.indexOf('::');
    if (castIdx !== -1) token = token.slice(0, castIdx).trim();
    if (token.includes('.')) continue; // nested relation column (e.g. author.name)
    if (!IDENT.test(token)) continue;
    cols.push(token);
  }
  return cols;
}

// ---------------------------------------------------------------------------
// Resolving the "rows" variable for a `select('*')` read.
// ---------------------------------------------------------------------------

type RowsResult =
  | { kind: 'var'; ident: string; declId: Node; scope: Node }
  | { kind: 'directAccess'; accesses: { column: string; ref: Node }[] }
  | { kind: 'escaped'; ref?: Node }
  | { kind: 'dead' };

function resolveRows(chain: ChainInfo): RowsResult {
  // 1. Trailing `.then(({ data }) => …)` callback.
  if (chain.thenCallback && (Node.isArrowFunction(chain.thenCallback) || Node.isFunctionExpression(chain.thenCallback))) {
    const fn = chain.thenCallback;
    const param = fn.getParameters()[0]?.getNameNode();
    const body = fn.getBody();
    return rowsFromBinding(param, body);
  }

  // 2. Result of (await) chain bound to a variable.
  const outer = chain.outerCall;
  const awaited = outer.getParent();
  const top = awaited && Node.isAwaitExpression(awaited) ? awaited : outer;
  const parent = top.getParent();
  if (!parent) return { kind: 'escaped', ref: top };

  if (Node.isVariableDeclaration(parent) && parent.getInitializer() === top) {
    const scope = parent.getFirstAncestorByKind(SyntaxKind.Block) ?? parent.getSourceFile();
    return rowsFromBinding(parent.getNameNode(), scope);
  }

  // 3. Result discarded as a bare statement → fetched but unused.
  if (Node.isExpressionStatement(parent)) return { kind: 'dead' };

  // 4. Anything else (returned, passed as arg, etc.) → escaped.
  return { kind: 'escaped', ref: top };
}

// Interpret a binding/parameter that receives the Supabase response and locate
// the rows. The response is `{ data, error }`, so rows live in `data`.
function rowsFromBinding(nameNode: Node | undefined, scope: Node | undefined): RowsResult {
  if (!nameNode || !scope) return { kind: 'escaped' };

  // `const data = await …` would capture the whole `{data,error}` response, so a
  // bare identifier here is NOT the rows — we'd have to trace `.data`. Don't guess.
  if (Node.isIdentifier(nameNode)) return { kind: 'escaped' };

  if (Node.isObjectBindingPattern(nameNode)) {
    for (const el of nameNode.getElements()) {
      const prop = el.getPropertyNameNode()?.getText() ?? el.getNameNode().getText();
      if (prop !== 'data') continue;
      const bound = el.getNameNode();
      if (Node.isIdentifier(bound)) {
        return { kind: 'var', ident: bound.getText(), declId: bound, scope };
      }
      if (Node.isObjectBindingPattern(bound)) {
        // `const { data: { id, name } } = …` — columns destructured directly.
        const accesses: { column: string; ref: Node }[] = [];
        for (const sub of bound.getElements()) {
          if (sub.getDotDotDotToken()) return { kind: 'escaped', ref: sub }; // `...rest`
          const name = sub.getPropertyNameNode()?.getText() ?? sub.getNameNode().getText();
          if (IDENT.test(name)) accesses.push({ column: name, ref: sub });
        }
        return { kind: 'directAccess', accesses };
      }
      return { kind: 'escaped', ref: bound };
    }
    return { kind: 'dead' }; // `data` not captured (e.g. only `{ error }`)
  }
  return { kind: 'escaped' };
}

// ---------------------------------------------------------------------------
// Scanning a rows variable's local scope for column property accesses.
// ---------------------------------------------------------------------------

function scanRowsVar(
  varName: string,
  declId: Node,
  scope: Node,
  columns: Set<string>,
): { accesses: { column: string; kind: AccessKind; node: Node }[]; escaped: boolean; escapeRef?: Node } {
  const accesses: { column: string; kind: AccessKind; node: Node }[] = [];
  let escaped = false;
  let escapeRef: Node | undefined;
  const escape = (n: Node) => {
    escaped = true;
    if (!escapeRef) escapeRef = n;
  };

  for (const id of scope.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id === declId) continue;
    if (id.getText() !== varName) continue;
    const parent = id.getParent();
    if (!parent) continue;

    // `rows.col` / `rows?.col`
    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === id) {
      const prop = parent.getName();
      if (columns.has(prop)) accesses.push({ column: prop, kind: inJsx(parent) ? 'jsx' : 'code', node: parent });
      else escape(parent); // opaque: `.map`, `.length`, `.find`, etc. hide columns
      continue;
    }

    // `rows['col']`
    if (Node.isElementAccessExpression(parent) && parent.getExpression() === id) {
      const key = literalString(parent.getArgumentExpression());
      if (key !== undefined && columns.has(key)) {
        accesses.push({ column: key, kind: inJsx(parent) ? 'jsx' : 'code', node: parent });
      } else {
        escape(parent); // numeric index / computed / non-column key
      }
      continue;
    }

    // `const { col } = rows`
    if (Node.isVariableDeclaration(parent) && parent.getInitializer() === id) {
      const nameNode = parent.getNameNode();
      if (Node.isObjectBindingPattern(nameNode)) {
        for (const el of nameNode.getElements()) {
          if (el.getDotDotDotToken()) {
            escape(el);
            continue;
          }
          const prop = el.getPropertyNameNode()?.getText() ?? el.getNameNode().getText();
          if (columns.has(prop)) accesses.push({ column: prop, kind: 'code', node: el });
        }
      } else {
        escape(parent); // `const x = rows` (alias) / array destructure
      }
      continue;
    }

    // Any other use of the whole rows object — call arg, return, spread,
    // setState, JSX-render of the object, assignment to an outer var, … —
    // is something we cannot follow. Be honest: escaped.
    escape(parent);
  }

  return { accesses, escaped, escapeRef };
}

export function inJsx(node: Node): boolean {
  return (
    node.getFirstAncestorByKind(SyntaxKind.JsxExpression) !== undefined ||
    node.getFirstAncestorByKind(SyntaxKind.JsxElement) !== undefined ||
    node.getFirstAncestorByKind(SyntaxKind.JsxFragment) !== undefined ||
    node.getFirstAncestorByKind(SyntaxKind.JsxSelfClosingElement) !== undefined ||
    node.getFirstAncestorByKind(SyntaxKind.JsxAttribute) !== undefined
  );
}

// ---------------------------------------------------------------------------
// Shared AST helpers (kept local so parseTs stays untouched).
// ---------------------------------------------------------------------------

export function findFromCalls(sf: SourceFile): CallExpression[] {
  const out: CallExpression[] = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (Node.isPropertyAccessExpression(expr) && expr.getName() === 'from') out.push(call);
  }
  return out;
}

export function resolveTableName(arg: Node | undefined): string | undefined {
  const direct = literalString(unwrapParens(arg));
  if (direct !== undefined) return direct;
  const inner = arg ? unwrapParens(arg) : undefined;
  if (inner && Node.isAsExpression(inner)) return literalString(unwrapParens(inner.getExpression()));
  return undefined;
}

function resolveTableArg(arg: Node | undefined): { name?: string; bypass: boolean } {
  return { name: resolveTableName(arg), bypass: false };
}

function isBareReturnedBuilder(fromCall: CallExpression, chain: ChainInfo): boolean {
  if (chain.outerCall !== fromCall) return false;
  return fromCall.getParent()?.getParent()?.getKind() === SyntaxKind.ReturnStatement;
}

export function unwrapParens(node: Node | undefined): Node | undefined {
  let current = node;
  while (current && Node.isParenthesizedExpression(current)) current = current.getExpression();
  return current;
}

export function literalString(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (Node.isStringLiteral(node)) return node.getLiteralValue();
  if (Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText();
  return undefined;
}

// Build a SourceRef from a node, grounding it in real code. Prefers the
// enclosing statement for context, but falls back to the node when that would
// produce an unwieldy snippet (e.g. a giant JSX return).
export function refFrom(node: Node, repoPath: string, sf: SourceFile): SourceRef {
  let target: Node = node;
  const stmt = enclosingStatement(node);
  if (stmt.getEndLineNumber() - stmt.getStartLineNumber() <= 6) target = stmt;

  const indent = sf.getFullText().slice(target.getStartLinePos(), target.getStart());
  const snippet = /^\s*$/.test(indent) ? indent + target.getText() : target.getText();
  return {
    language: 'typescript',
    filePath: path.relative(repoPath, sf.getFilePath()),
    startLine: target.getStartLineNumber(),
    endLine: target.getEndLineNumber(),
    snippet,
  };
}

function enclosingStatement(node: Node): Node {
  let current: Node | undefined = node;
  while (current) {
    if (current.getKindName().endsWith('Statement')) return current;
    current = current.getParent();
  }
  return node;
}
