import {
  Node,
  SyntaxKind,
  type CallExpression,
  type ElementAccessExpression,
  type Project,
  type PropertyAccessExpression,
  type SourceFile,
} from 'ts-morph';
import type { ColumnReach, GraphNode, SourceRef, SqlViewRead } from '@throughline/core';
import {
  EXCLUDE,
  inJsx,
  literalString,
  refFrom,
  resolveTableName,
  walkChain,
  type ChainInfo,
} from './columnUsage.js';
import { isTypedClient } from './parseTs.js';
import { collectTableHelperAliases, findTableAccesses, type TableAccess } from './tableHelpers.js';

// ---------------------------------------------------------------------------
// Reach analysis (TypeScript only) — the B1 axis.
//
// For each contract column we answer WHERE its value travels once read:
//
//   ui_shown    a (typed) read of the column resolves to a property access
//               inside JSX — it is shown to a user.
//   server_only the column is read (named in a select, or accessed via a typed
//               value) but ONLY ever outside JSX, fully traced, no escape.
//   never_read  no read references the column AND we traced confidently enough
//               that nothing could be hiding it.
//   unknown     a read exists but the value escapes into untyped/unresolvable
//               scope, OR an escaping/untyped `select('*')` of the table could
//               be hiding the column. Always carries an escape-trail.
//
// We trace each read's result variable with findReferences (cross-file when the
// value is typed), following pass-through hops up to a cap. The bias is
// conservative: property access on an `any`-typed value is NOT trusted, and in
// any doubt we return `unknown` (never a false dead / not-shown).
// ---------------------------------------------------------------------------

export interface ReachResult {
  reach: ColumnReach;
  escapeTrail?: SourceRef[];
}

// Array methods whose first callback parameter is a single row.
const ROW_ITERATEES = new Set([
  'map',
  'forEach',
  'filter',
  'find',
  'findLast',
  'findIndex',
  'some',
  'every',
  'flatMap',
]);
// Methods whose RESULT is still a collection of the SAME rows (so we can keep
// following it). `map`/`flatMap` change the element type, so they are handled
// via the callback body in handleScalar instead.
const RESULT_COLLECTION = new Set(['filter', 'slice', 'concat', 'sort', 'reverse']);
const RESULT_ROW = new Set(['find', 'findLast', 'at']);
// Methods whose callback BODY value is extracted into the result (its reach is
// the reach of that result).
const EXTRACTING = new Set(['map', 'flatMap']);

const MAX_HOPS = 6;
const MAX_TRAIL = 5;

type Shape = { k: 'collection' } | { k: 'row' } | { k: 'scalar'; col: string } | { k: 'response' };

interface ReachAcc {
  columns: Set<string>;
  jsx: Map<string, SourceRef[]>; // confident JSX accesses → ui_shown
  server: Map<string, SourceRef[]>; // confident non-JSX property accesses → server_only
  colEscapes: Map<string, SourceRef[]>; // a known column's value flowed into untyped scope → unknown
  explicitSelected: Set<string>; // named in an explicit `select(...)` — fetched server-side (weak server signal)
  hidingReads: SourceRef[]; // an escaping/untyped read that could hide ANY column
  opaqueSqlViews: SourceRef[]; // SQL view reads this table, but exact columns are opaque
}

interface Ctx {
  repoPath: string;
  acc: ReachAcc;
  named: string[] | null; // explicit-select columns for THIS read (null === star)
  rowsShape: Shape; // {row} or {collection} for this read
  hop: number;
  trail: SourceRef[];
  visited: Set<string>;
  jsxFiles: Map<string, boolean>; // per-run cache: does this file contain any JSX?
}

export function computeReach(
  repoPath: string,
  contracts: GraphNode[],
  project: Project,
  sqlViewReads: SqlViewRead[] = [],
): Map<string, Map<string, ReachResult>> {
  const tables = new Map<string, ReachAcc>();
  for (const c of contracts) {
    if (!c.columns || c.columns.length === 0) continue;
    tables.set(c.label, {
      columns: new Set(c.columns.map((col) => col.name)),
      jsx: new Map(),
      server: new Map(),
      colEscapes: new Map(),
      explicitSelected: new Set(),
      hidingReads: [],
      opaqueSqlViews: [],
    });
  }
  if (tables.size === 0) return new Map();

  applySqlViewReads(tables, sqlViewReads);
  const helperAliases = collectTableHelperAliases(
    project,
    repoPath,
    new Set(tables.keys()),
    isTypedClient,
    resolveTableArg,
  );

  const jsxFiles = new Map<string, boolean>();
  for (const sf of project.getSourceFiles()) {
    if (EXCLUDE.test(sf.getFilePath())) continue;
    try {
      for (const access of findTableAccesses(sf, helperAliases, resolveTableArg)) {
        const acc = tables.get(access.table);
        if (!acc) continue;
        traceRead(access, acc, repoPath, jsxFiles);
      }
    } catch {
      // A malformed file must never sink the whole analysis; skip it.
    }
  }

  const out = new Map<string, Map<string, ReachResult>>();
  for (const [table, acc] of tables) {
    const m = new Map<string, ReachResult>();
    for (const col of acc.columns) m.set(col, decide(col, acc));
    out.set(table, m);
  }
  return out;
}

// Combine the accumulated evidence into one reach verdict, highest-confidence
// first:
//   1. a property access INSIDE JSX                → ui_shown   (it IS shown, anywhere)
//   2. the value flowed into untyped/untraceable scope
//                                                  → unknown    (can't claim "not shown")
//   3. a fully-traced property access OUTSIDE JSX   → server_only (read, never reaches a render)
//   4. named in an explicit select, nothing else   → server_only (fetched, never observed)
//   5. an escaping/untyped `*` read could hide it  → unknown
//   6. otherwise                                   → never_read
//
// `unknown` outranks `server_only` on purpose: once a value escapes where we
// cannot follow it, we must NOT assert it never reaches the UI. server_only is
// reserved for reads we fully resolved and saw stay off-screen.
function decide(col: string, acc: ReachAcc): ReachResult {
  const jsx = acc.jsx.get(col);
  if (jsx && jsx.length > 0) return { reach: 'ui_shown' };

  const colEsc = acc.colEscapes.get(col);
  if (colEsc && colEsc.length > 0) return { reach: 'unknown', escapeTrail: colEsc.slice(0, MAX_TRAIL) };

  const server = acc.server.get(col);
  if (server && server.length > 0) return { reach: 'server_only' };

  if (acc.explicitSelected.has(col)) return { reach: 'server_only' };

  if (acc.hidingReads.length > 0) return { reach: 'unknown', escapeTrail: acc.hidingReads.slice(0, MAX_TRAIL) };

  if (acc.opaqueSqlViews.length > 0) return { reach: 'unknown', escapeTrail: acc.opaqueSqlViews.slice(0, MAX_TRAIL) };

  return { reach: 'never_read' };
}

function applySqlViewReads(tables: Map<string, ReachAcc>, sqlViewReads: SqlViewRead[]) {
  for (const read of sqlViewReads) {
    const acc = tables.get(read.table);
    if (!acc) continue;
    if (read.confidence === 'certain') {
      for (const col of read.columns ?? []) {
        if (acc.columns.has(col)) push(acc.server, col, read.source);
      }
    } else {
      acc.opaqueSqlViews.push(read.source);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-read tracing.
// ---------------------------------------------------------------------------

function traceRead(access: TableAccess, acc: ReachAcc, repoPath: string, jsxFiles: Map<string, boolean>) {
  const chain = walkChain(access.rootCall);
  if (chain.isWrite) return;

  const named = chain.explicitColumns ? chain.explicitColumns.filter((c) => acc.columns.has(c)) : null;
  if (!access.alias && isBareReturnedBuilder(access.rootCall, chain)) return;

  // Naming a column in an explicit `.select(...)` proves it is FETCHED
  // server-side, but says nothing about where the value then travels. Record it
  // as a weak server signal (ranked below a real escape or a real access), so a
  // selected-but-untraced column lands on server_only rather than never_read.
  if (named && named.length > 0) for (const col of named) acc.explicitSelected.add(col);

  const rowsShape: Shape = chain.single ? { k: 'row' } : { k: 'collection' };
  const ctx: Ctx = {
    repoPath,
    acc,
    named: named && named.length > 0 ? named : null,
    rowsShape,
    hop: 0,
    trail: [],
    visited: new Set(),
    jsxFiles,
  };

  const binding = resolveResultBinding(chain);
  if (binding.kind === 'none') return; // fetched but not bound, or only `{ error }` — no reach signal
  if (binding.kind === 'escaped') {
    recordEscape(ctx, rowsShape, binding.ref ?? access.rootCall);
    return;
  }
  if (binding.kind === 'directCols') {
    // `const { data: { x, y } } = …` — each captured field is one column's value.
    for (const { name, ident } of binding.cols) {
      if (!acc.columns.has(name)) continue;
      traceBinding(ident, { k: 'scalar', col: name }, ctx);
    }
    return;
  }
  if (binding.kind === 'response') {
    traceBinding(binding.ident, { k: 'response' }, ctx);
    return;
  }
  // kind === 'rowsVar'
  traceBinding(binding.ident, rowsShape, ctx);
}

type Binding =
  | { kind: 'rowsVar'; ident: Node }
  | { kind: 'directCols'; cols: { name: string; ident: Node }[] }
  | { kind: 'response'; ident: Node }
  | { kind: 'escaped'; ref?: Node }
  | { kind: 'none' };

// Find the identifier that receives the rows for a read, so we can run
// findReferences on it. Mirrors columnUsage's resolveRows, but keeps the
// binding node (not just a yes/no) because reach needs to follow it.
function resolveResultBinding(chain: ChainInfo): Binding {
  if (chain.thenCallback && (Node.isArrowFunction(chain.thenCallback) || Node.isFunctionExpression(chain.thenCallback))) {
    const param = chain.thenCallback.getParameters()[0]?.getNameNode();
    return fromResponsePattern(param);
  }

  // Climb past `await`, `(…)`, and `… as T` so we land on the binding (if any).
  let top: Node = chain.outerCall;
  for (;;) {
    const p = top.getParent();
    if (!p) break;
    const isAwait = Node.isAwaitExpression(p) && p.getExpression() === top;
    const isWrap =
      (Node.isParenthesizedExpression(p) || Node.isAsExpression(p) || Node.isNonNullExpression(p) || Node.isTypeAssertion(p)) &&
      (p as { getExpression(): Node }).getExpression() === top;
    if (isAwait || isWrap) {
      top = p;
      continue;
    }
    break;
  }
  const parent = top.getParent();
  if (!parent) return { kind: 'escaped', ref: top };

  if (Node.isVariableDeclaration(parent) && parent.getInitializer() === top) {
    return fromResponsePattern(parent.getNameNode());
  }
  if (Node.isExpressionStatement(parent)) return { kind: 'none' };
  return { kind: 'escaped', ref: top };
}

function fromResponsePattern(nameNode: Node | undefined): Binding {
  if (!nameNode) return { kind: 'escaped' };
  // `const data = await …` captures the whole `{ data, error }` response.
  if (Node.isIdentifier(nameNode)) return { kind: 'response', ident: nameNode };
  if (Node.isObjectBindingPattern(nameNode)) {
    for (const el of nameNode.getElements()) {
      const prop = el.getPropertyNameNode()?.getText() ?? el.getNameNode().getText();
      if (prop !== 'data') continue;
      const bound = el.getNameNode();
      if (Node.isIdentifier(bound)) return { kind: 'rowsVar', ident: bound };
      if (Node.isObjectBindingPattern(bound)) {
        const cols: { name: string; ident: Node }[] = [];
        for (const sub of bound.getElements()) {
          if (sub.getDotDotDotToken()) return { kind: 'escaped', ref: sub };
          const name = sub.getPropertyNameNode()?.getText() ?? sub.getNameNode().getText();
          const id = sub.getNameNode();
          if (Node.isIdentifier(id)) cols.push({ name, ident: id });
        }
        return { kind: 'directCols', cols };
      }
      return { kind: 'escaped', ref: bound };
    }
    return { kind: 'none' };
  }
  return { kind: 'escaped' };
}

// ---------------------------------------------------------------------------
// The reference walker.
// ---------------------------------------------------------------------------

function traceBinding(declIdent: Node, shape: Shape, ctx: Ctx) {
  if (!Node.isIdentifier(declIdent)) return;
  const key = `${declIdent.getSourceFile().getFilePath()}:${declIdent.getStart()}:${shapeKey(shape)}`;
  if (ctx.visited.has(key)) return;
  ctx.visited.add(key);

  if (ctx.hop > MAX_HOPS) {
    recordEscape(ctx, shape, declIdent);
    return;
  }

  let refs: Node[] = [];
  try {
    refs = declIdent.findReferencesAsNodes();
  } catch {
    refs = [];
  }
  for (const ref of refs) {
    if (ref === declIdent) continue;
    if (ref.getSourceFile() && EXCLUDE.test(ref.getSourceFile().getFilePath())) continue;
    if (isTypeContext(ref)) continue; // a name appearing in a type annotation, not a value use
    handleUsage(ref, shape, ctx);
  }
}

// findReferences also returns occurrences of the name inside type annotations
// (e.g. the `data` in `const { data }: { data: Row }`). Those are not value uses
// and must not be treated as the value escaping.
function isTypeContext(node: Node): boolean {
  return (
    node.getFirstAncestor(
      (a) =>
        Node.isTypeNode(a) ||
        Node.isPropertySignature(a) ||
        Node.isTypeAliasDeclaration(a) ||
        Node.isInterfaceDeclaration(a),
    ) !== undefined
  );
}

function handleUsage(value: Node, shape: Shape, ctx: Ctx) {
  const target = climbValue(value);
  const parent = target.getParent();
  if (!parent) return;
  const sf = target.getSourceFile();

  if (shape.k === 'scalar') {
    handleScalar(target, parent, shape.col, ctx, sf);
    return;
  }
  if (shape.k === 'response') {
    // `resp.data` → the rows; `resp.error` → ignore; anything else → escape.
    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === target) {
      const name = parent.getName();
      if (name === 'data') {
        handleUsage(parent, ctx.rowsShape, { ...ctx, hop: ctx.hop + 1, trail: [...ctx.trail, refFrom(parent, ctx.repoPath, sf)] });
      }
      return; // `.error`, `.status`, … are not columns
    }
    recordEscape(ctx, ctx.rowsShape, target);
    return;
  }

  // --- row or collection ---
  if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === target) {
    if (shape.k === 'row') {
      handleRowProperty(target, parent, ctx, sf);
      return;
    }
    // collection
    handleCollectionMethod(target, parent, ctx, sf);
    return;
  }
  if (Node.isElementAccessExpression(parent) && parent.getExpression() === target) {
    if (shape.k === 'row') {
      handleRowElement(target, parent, ctx, sf); // row['col']
    } else {
      // collection[i] → a single row value
      handleUsage(parent, { k: 'row' }, { ...ctx, hop: ctx.hop + 1, trail: pushTrail(ctx, parent, sf) });
    }
    return;
  }

  handlePassthrough(target, parent, shape, ctx, sf);
}

// `row.col` (single row). Classify the column's value by where it lands.
function handleRowProperty(target: Node, access: Node, ctx: Ctx, sf: SourceFile) {
  if (isUntyped(target)) {
    // We cannot trust the property name to really be this column → escape.
    recordEscape(ctx, { k: 'row' }, access);
    return;
  }
  const col = (access as PropertyAccessExpression).getName();
  if (!ctx.acc.columns.has(col)) return; // `.length`, `.map`, helper props — not a column
  classifyColumnValue(col, access, ctx, sf);
}

function handleRowElement(_target: Node, access: Node, ctx: Ctx, sf: SourceFile) {
  const key = literalString((access as ElementAccessExpression).getArgumentExpression());
  if (key !== undefined && ctx.acc.columns.has(key)) {
    classifyColumnValue(key, access, ctx, sf);
    return;
  }
  // computed / numeric key on a row → which column is opaque → escape.
  recordEscape(ctx, { k: 'row' }, access);
}

// `rows.<method>(cb)` on a collection.
function handleCollectionMethod(_target: Node, prop: Node, ctx: Ctx, sf: SourceFile) {
  const method = (prop as PropertyAccessExpression).getName();
  const gp = prop.getParent();
  if (!gp || !Node.isCallExpression(gp) || gp.getExpression() !== prop) {
    // bare `.length`, or a method reference — no column extracted.
    return;
  }
  if (ROW_ITERATEES.has(method)) {
    const cb = gp.getArguments()[0];
    if (cb && (Node.isArrowFunction(cb) || Node.isFunctionExpression(cb))) {
      const p0 = cb.getParameters()[0]?.getNameNode();
      if (p0 && Node.isIdentifier(p0)) {
        traceBinding(p0, { k: 'row' }, { ...ctx, hop: ctx.hop + 1, trail: pushTrail(ctx, prop, sf) });
      } else if (p0 && Node.isObjectBindingPattern(p0)) {
        for (const el of p0.getElements()) {
          if (el.getDotDotDotToken()) continue;
          const name = el.getPropertyNameNode()?.getText() ?? el.getNameNode().getText();
          const id = el.getNameNode();
          if (ctx.acc.columns.has(name) && Node.isIdentifier(id)) {
            traceBinding(id, { k: 'scalar', col: name }, { ...ctx, hop: ctx.hop + 1, trail: pushTrail(ctx, prop, sf) });
          }
        }
      }
    }
  }
  // Follow the method RESULT too (e.g. `rows.filter(..).map(..)`).
  if (RESULT_COLLECTION.has(method)) {
    handleUsage(gp, { k: 'collection' }, { ...ctx, hop: ctx.hop + 1, trail: pushTrail(ctx, gp, sf) });
  } else if (RESULT_ROW.has(method)) {
    handleUsage(gp, { k: 'row' }, { ...ctx, hop: ctx.hop + 1, trail: pushTrail(ctx, gp, sf) });
  }
}

// A scalar value known to be `col`. Where does it end up?
function handleScalar(target: Node, parent: Node, col: string, ctx: Ctx, sf: SourceFile) {
  if (isUntyped(target)) {
    recordEscape(ctx, { k: 'scalar', col }, target);
    return;
  }
  if (inJsx(target)) {
    push(ctx.acc.jsx, col, refFrom(target, ctx.repoPath, sf));
    return;
  }
  // alias: `const x = <scalar>`
  if (Node.isVariableDeclaration(parent) && parent.getInitializer() === target) {
    const name = parent.getNameNode();
    if (Node.isIdentifier(name)) {
      traceBinding(name, { k: 'scalar', col }, { ...ctx, hop: ctx.hop + 1, trail: pushTrail(ctx, target, sf) });
      return;
    }
  }
  if (isReturnPosition(target, parent)) {
    const fn = enclosingFunction(target);
    const name = fn ? functionNameIdent(fn) : undefined;
    if (name && Node.isIdentifier(name)) {
      // Returned from a named function → follow its callers (cross-file).
      followReturn(target, { k: 'scalar', col }, ctx, sf);
      return;
    }
    const ext = extractionCall(target);
    if (ext) {
      // `rows.map(r => r.col)` — the column flows into the map result; its reach
      // is wherever that result goes.
      handleUsage(ext, { k: 'scalar', col }, { ...ctx, hop: ctx.hop + 1, trail: pushTrail(ctx, target, sf) });
      return;
    }
    // Anonymous callback (filter predicate, forEach, sort, …) — a typed read
    // used in place. Not shown, not lost: server-side.
    push(ctx.acc.server, col, refFrom(target, ctx.repoPath, sf));
    return;
  }
  if (isCallArgument(target, parent)) {
    followArgument(target, parent as CallExpression, { k: 'scalar', col }, ctx, sf);
    return;
  }
  // Any other plain code use (comparison, template, arithmetic, prop init…).
  push(ctx.acc.server, col, refFrom(target, ctx.repoPath, sf));
}

function classifyColumnValue(col: string, access: Node, ctx: Ctx, sf: SourceFile) {
  // The column's value IS `access` (e.g. `row.col`). Hand it to the scalar
  // tracer so a value that flows on into JSX is still caught as ui_shown.
  handleScalar(access, access.getParent()!, col, ctx, sf);
}

// The whole row/collection is used in some non-extracting way.
function handlePassthrough(target: Node, parent: Node, shape: Shape, ctx: Ctx, sf: SourceFile) {
  if (Node.isVariableDeclaration(parent) && parent.getInitializer() === target) {
    const name = parent.getNameNode();
    if (Node.isIdentifier(name)) {
      traceBinding(name, shape, { ...ctx, hop: ctx.hop + 1, trail: pushTrail(ctx, target, sf) });
      return;
    }
    if (shape.k === 'collection' && Node.isArrayBindingPattern(name)) {
      // `const [first] = rows` → first is a row.
      const first = name.getElements()[0];
      if (first && Node.isBindingElement(first)) {
        const id = first.getNameNode();
        if (Node.isIdentifier(id)) {
          traceBinding(id, { k: 'row' }, { ...ctx, hop: ctx.hop + 1, trail: pushTrail(ctx, target, sf) });
          return;
        }
      }
    }
    recordEscape(ctx, shape, target);
    return;
  }
  if (isReturnPosition(target, parent)) {
    followReturn(target, shape, ctx, sf);
    return;
  }
  if (isCallArgument(target, parent)) {
    followArgument(target, parent as CallExpression, shape, ctx, sf);
    return;
  }
  // Spread, JSX-render of the whole object, assignment to an outer var, … — we
  // cannot follow which columns surface. Conservative: escape.
  recordEscape(ctx, shape, target);
}

// Follow a value returned from a function to that function's call sites (this
// is the cross-file step — findReferences on the function name resolves across
// modules when the value is typed).
function followReturn(target: Node, shape: Shape, ctx: Ctx, sf: SourceFile) {
  const fn = enclosingFunction(target);
  const nameIdent = fn ? functionNameIdent(fn) : undefined;
  if (!nameIdent || !Node.isIdentifier(nameIdent)) {
    recordEscape(ctx, shape, target);
    return;
  }
  let refs: Node[] = [];
  try {
    refs = nameIdent.findReferencesAsNodes();
  } catch {
    refs = [];
  }
  let followed = false;
  for (const ref of refs) {
    if (ref === nameIdent) continue;
    const callExpr = ref.getParent();
    if (!callExpr || !Node.isCallExpression(callExpr) || callExpr.getExpression() !== climbCallee(ref)) continue;
    if (EXCLUDE.test(callExpr.getSourceFile().getFilePath())) continue;
    const awaited = callExpr.getParent();
    const result = awaited && Node.isAwaitExpression(awaited) ? awaited : callExpr;
    followed = true;
    handleUsage(result, shape, { ...ctx, hop: ctx.hop + 1, trail: pushTrail(ctx, target, sf) });
  }
  if (!followed) {
    // Returned out of all analyzable scope (uncalled, or callers excluded).
    recordEscape(ctx, shape, target);
  }
}

// Follow a value passed as a call argument into the callee's parameter — but
// only when the callee resolves and the parameter is typed (non-any).
function followArgument(target: Node, call: CallExpression, shape: Shape, ctx: Ctx, sf: SourceFile) {
  const args = call.getArguments();
  const idx = args.findIndex((a) => a === target);
  const decl = idx >= 0 ? resolveCalleeDeclaration(call) : undefined;
  const param = decl?.getParameters()[idx];
  if (param && Node.isIdentifier(param) && !isUntyped(param)) {
    traceBinding(param, shape, { ...ctx, hop: ctx.hop + 1, trail: pushTrail(ctx, target, sf) });
    return;
  }
  recordEscape(ctx, shape, target);
}

// ---------------------------------------------------------------------------
// Recording.
// ---------------------------------------------------------------------------

// A value left scope where we could not follow it. WHERE it escaped matters: a
// file with no JSX (an api route or a `.ts` server lib) physically cannot render
// it, so that is server evidence; an escape inside a component (a file with JSX)
// could be prop-drilled into a render, so it is genuinely `unknown`.
function recordEscape(ctx: Ctx, shape: Shape, node: Node) {
  const sf = node.getSourceFile();
  const site = refFrom(node, ctx.repoPath, sf);
  const trail = [...ctx.trail, site].slice(0, MAX_TRAIL);
  const couldRender = fileHasJsx(sf, ctx.jsxFiles);

  if (shape.k === 'scalar') {
    if (couldRender) pushAll(ctx.acc.colEscapes, shape.col, trail);
    else push(ctx.acc.server, shape.col, site);
    return;
  }
  if (ctx.named && ctx.named.length > 0) {
    for (const col of ctx.named) {
      if (couldRender) pushAll(ctx.acc.colEscapes, col, trail);
      else push(ctx.acc.server, col, site);
    }
    return;
  }
  // Star read whose result we could not follow — unknown which columns; could be
  // hiding any of them (and a server-file escape can still cross HTTP to a client).
  for (const ref of trail) ctx.acc.hidingReads.push(ref);
}

function fileHasJsx(sf: SourceFile, cache: Map<string, boolean>): boolean {
  const key = sf.getFilePath();
  let v = cache.get(key);
  if (v === undefined) {
    v =
      sf.getFirstDescendant(
        (n) => Node.isJsxElement(n) || Node.isJsxSelfClosingElement(n) || Node.isJsxFragment(n),
      ) !== undefined;
    cache.set(key, v);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function shapeKey(s: Shape): string {
  return s.k === 'scalar' ? `scalar:${s.col}` : s.k;
}

function pushTrail(ctx: Ctx, node: Node, sf: SourceFile): SourceRef[] {
  return [...ctx.trail, refFrom(node, ctx.repoPath, sf)].slice(0, MAX_TRAIL);
}

function push(map: Map<string, SourceRef[]>, key: string, ref: SourceRef) {
  const arr = map.get(key);
  if (arr) arr.push(ref);
  else map.set(key, [ref]);
}

function pushAll(map: Map<string, SourceRef[]>, key: string, refs: SourceRef[]) {
  const arr = map.get(key);
  if (arr) arr.push(...refs);
  else map.set(key, [...refs]);
}

// Climb through value-preserving wrappers: `x!`, `(x)`, `x as T`, `<T>x`, and the
// left side of `x ?? d` / `x || d` (the `(rows ?? []).map(...)` idiom — the value
// is still our rows when the fallback isn't taken).
function climbValue(node: Node): Node {
  let cur = node;
  for (;;) {
    const p = cur.getParent();
    if (!p) return cur;
    if (
      (Node.isNonNullExpression(p) || Node.isParenthesizedExpression(p) || Node.isAsExpression(p) || Node.isTypeAssertion(p)) &&
      (p as { getExpression(): Node }).getExpression() === cur
    ) {
      cur = p;
      continue;
    }
    if (Node.isBinaryExpression(p) && p.getLeft() === cur) {
      const op = p.getOperatorToken().getText();
      if (op === '??' || op === '||') {
        cur = p;
        continue;
      }
    }
    return cur;
  }
}

// For a function-name reference inside a call, the callee may be `f` or `obj.f`.
function climbCallee(ref: Node): Node {
  const p = ref.getParent();
  if (p && Node.isPropertyAccessExpression(p) && p.getNameNode() === ref) return p;
  return ref;
}

function isReturnPosition(target: Node, parent: Node): boolean {
  if (Node.isReturnStatement(parent)) return true;
  // arrow concise body: `(r) => <expr>`
  if (Node.isArrowFunction(parent) && parent.getBody() === target) return true;
  return false;
}

function isCallArgument(target: Node, parent: Node): boolean {
  return Node.isCallExpression(parent) && parent.getExpression() !== target && parent.getArguments().includes(target);
}

// If `target` is the body/return value of a `map`/`flatMap` callback, return the
// iteratee call whose result the value flows into.
function extractionCall(target: Node): CallExpression | undefined {
  const fn = enclosingFunction(target);
  if (!fn || !(Node.isArrowFunction(fn) || Node.isFunctionExpression(fn))) return undefined;
  const call = fn.getParent();
  if (call && Node.isCallExpression(call) && call.getArguments().includes(fn)) {
    const callee = call.getExpression();
    if (Node.isPropertyAccessExpression(callee) && EXTRACTING.has(callee.getName())) return call;
  }
  return undefined;
}

function enclosingFunction(node: Node): Node | undefined {
  return node.getFirstAncestor(
    (a) =>
      Node.isFunctionDeclaration(a) ||
      Node.isArrowFunction(a) ||
      Node.isFunctionExpression(a) ||
      Node.isMethodDeclaration(a),
  );
}

function functionNameIdent(fn: Node): Node | undefined {
  if (Node.isFunctionDeclaration(fn)) {
    const n = fn.getNameNode();
    return n && Node.isIdentifier(n) ? n : undefined;
  }
  const p = fn.getParent();
  if (p && Node.isVariableDeclaration(p)) {
    const n = p.getNameNode();
    return Node.isIdentifier(n) ? n : undefined;
  }
  return undefined;
}

function resolveCalleeDeclaration(call: CallExpression): { getParameters: () => Node[] } | undefined {
  const expr = call.getExpression();
  let sym = expr.getSymbol();
  if (!sym && Node.isPropertyAccessExpression(expr)) sym = expr.getNameNode().getSymbol();
  const decl = sym?.getDeclarations()?.[0];
  if (!decl) return undefined;
  if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl) || Node.isFunctionExpression(decl) || Node.isArrowFunction(decl)) {
    return { getParameters: () => decl.getParameters().map((p) => p.getNameNode()) };
  }
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      return { getParameters: () => init.getParameters().map((p) => p.getNameNode()) };
    }
  }
  return undefined;
}

function isUntyped(node: Node): boolean {
  try {
    const t = node.getType();
    return t.isAny() || t.isUnknown();
  } catch {
    return true; // can't resolve a type → don't trust it
  }
}

function resolveTableArg(arg: Node | undefined): { name?: string; bypass: boolean } {
  return { name: resolveTableName(arg), bypass: false };
}

function isBareReturnedBuilder(fromCall: CallExpression, chain: ChainInfo): boolean {
  if (chain.outerCall !== fromCall) return false;
  return fromCall.getParent()?.getParent()?.getKind() === SyntaxKind.ReturnStatement;
}
