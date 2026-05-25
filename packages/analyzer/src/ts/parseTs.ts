import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  Node,
  Project,
  SyntaxKind,
  type CallExpression,
  type SourceFile,
  type Type,
} from 'ts-morph';
import type {
  EdgeDirection,
  GraphEdge,
  GraphNode,
  RootCause,
  SourceRef,
  TableHelperAlias,
  Trust,
  TrustReason,
} from '@throughline/core';
import { classifySourceScope } from '../sourceScope.js';
import {
  classifyUnresolved,
  resolveClientOrigin,
  rollupRootCauses,
  UNRESOLVED_ORIGIN,
  type RootCauseInput,
} from './rootCause.js';
import { collectTableHelperAliases, findTableAccesses, type TableAccess } from './tableHelpers.js';

const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete']);
const ANY_LIKE = /^(any|unknown|never)$/;
// File paths we never want to analyze.
const EXCLUDE = /[/\\](node_modules|\.next|dist|out|build|\.turbo)[/\\]|\.d\.ts$/;

export interface ParseTsResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  // RC-a (additive): deterministic root-cause rollup of the dark/asserted TS
  // touches found in this pass, ranked biggest-lever-first.
  rootCauses: RootCause[];
  helperAliases: TableHelperAlias[];
}

// Detect where TypeScript reads or writes a database contract, and assign each
// touch an honest trust level. v1 scope is deliberately tight: ONLY Supabase
// fluent-client table access — CallExpressions of the form `.from('<table>')`
// whose argument resolves to a string literal. No field-level flow, no
// cross-file tracing, no HTTP/JSON boundaries (those are later steps).
//
// Honesty bias: when the type isn't genuinely carried, prefer `dark`. A loose
// (non-`SupabaseClient<Database>`) client without a cast is `dark`, not verified.
export async function parseTs(
  repoPath: string,
  contracts: GraphNode[],
  project: Project = loadProject(repoPath),
): Promise<ParseTsResult> {
  const knownTables = new Set(contracts.map((c) => c.label));

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const usedIds = new Set<string>();
  const helperAliases = collectTableHelperAliases(
    project,
    repoPath,
    knownTables,
    isTypedClient,
    resolveTableName,
  );
  // RC-a: per-touch facts for dark/asserted touches, rolled up at the end.
  const rootCauseInputs: RootCauseInput[] = [];

  // diagnostics (env-gated debug only)
  let filesScanned = 0;
  let filesSkipped = 0;
  let unmatched = 0;
  const unmatchedTables = new Map<string, number>();

  for (const sf of project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    if (EXCLUDE.test(filePath)) continue;

    try {
      filesScanned += 1;
      for (const access of findTableAccesses(sf, helperAliases, resolveTableName)) {
        // Don't fabricate a contract for a table we never parsed from SQL.
        if (!knownTables.has(access.table)) {
          unmatched += 1;
          unmatchedTables.set(access.table, (unmatchedTables.get(access.table) ?? 0) + 1);
          continue;
        }

        const touch = describeTouch(access, repoPath, sf);
        const id = uniqueId(touch.id, usedIds);

        nodes.push({
          id,
          kind: 'touch',
          language: 'typescript',
          label: `${touch.direction} ${access.table}`,
          trust: touch.trust,
          trustReason: touch.trustReason,
          sourceScope: touch.sourceScope,
          source: touch.source,
          notes: touch.notes,
        });
        edges.push({
          id: `edge:${id}`,
          source: id,
          target: `contract:${access.table}`,
          direction: touch.direction,
        });

        // RC-a: only dark/asserted touches have a root cause worth flipping.
        // The origin is resolved deterministically; loose resolution → unresolved,
        // and an unresolved origin is classified by shape (why it's unresolved).
        if (touch.trust === 'dark' || touch.trust === 'asserted') {
          const origin = access.alias
            ? { name: access.alias.functionName, source: access.alias.source }
            : resolveClientOrigin(access.rootCall, repoPath);
          let evidence: SourceRef | undefined;
          if (!access.alias && origin.name === UNRESOLVED_ORIGIN) {
            const classified = classifyUnresolved(access.rootCall, repoPath);
            origin.shape = classified.shape;
            evidence = classified.evidence;
          }
          rootCauseInputs.push({
            touchId: id,
            reason: touch.trustReason,
            contract: access.table,
            origin,
            evidence,
            sourceScope: touch.sourceScope,
          });
        }
      }
    } catch (err) {
      filesSkipped += 1;
      if (process.env.THROUGHLINE_TS_DEBUG) {
        console.error(`[parseTs] skipped ${path.relative(repoPath, filePath)}: ${shortError(err)}`);
      }
    }
  }

  if (process.env.THROUGHLINE_TS_DEBUG) {
    const byDir = tally(nodes, (n) => n.label.split(' ')[0]);
    const byTrust = tally(nodes, (n) => n.trust ?? 'none');
    const byTable = tally(nodes, (n) => n.label.split(' ').slice(1).join(' '));
    console.error(
      JSON.stringify(
        {
          repoPath,
          filesScanned,
          filesSkipped,
          touchNodes: nodes.length,
          byDirection: byDir,
          byTrust,
          byTable: Object.fromEntries(
            Object.entries(byTable).sort((a, b) => b[1] - a[1]),
          ),
          unmatched,
          unmatchedTables: Object.fromEntries(
            [...unmatchedTables.entries()].sort((a, b) => b[1] - a[1]),
          ),
        },
        null,
        2,
      ),
    );
  }

  return { nodes, edges, rootCauses: rollupRootCauses(rootCauseInputs), helperAliases: [...helperAliases.values()] };
}

// ---------------------------------------------------------------------------
// Project loading
// ---------------------------------------------------------------------------

// Exported so sibling analyzers (e.g. columnUsage) can share ONE ts-morph
// Project per run instead of paying for type resolution twice.
export function loadProject(repoPath: string): Project {
  const tsconfig = path.join(repoPath, 'tsconfig.json');
  if (existsSync(tsconfig)) {
    // Loading from tsconfig gives us real type resolution (needed to tell a
    // genuinely-typed SupabaseClient<Database> apart from a loose one).
    return new Project({ tsConfigFilePath: tsconfig });
  }
  const project = new Project({ compilerOptions: { allowJs: false, skipLibCheck: true } });
  project.addSourceFilesAtPaths([
    path.join(repoPath, '**/*.ts'),
    path.join(repoPath, '**/*.tsx'),
    `!${path.join(repoPath, '**/node_modules/**')}`,
    `!${path.join(repoPath, '**/.next/**')}`,
    `!${path.join(repoPath, '**/dist/**')}`,
    '!**/*.d.ts',
  ]);
  return project;
}

// ---------------------------------------------------------------------------
// Per-touch analysis
// ---------------------------------------------------------------------------

interface TableArg {
  name?: string;
  bypass: boolean; // table accessed via `as any/unknown/never`
}

interface TouchInfo {
  id: string;
  direction: EdgeDirection;
  trust: Trust;
  trustReason: TrustReason;
  sourceScope: GraphNode['sourceScope'];
  source: SourceRef;
  notes: string;
}

function describeTouch(
  access: TableAccess,
  repoPath: string,
  sf: SourceFile,
): TouchInfo {
  const tableName = access.table;
  const chain = analyzeChain(access.rootCall);
  const typedClient = access.alias ? access.alias.requiresTypedClient : isTypedClient(access.rootCall);
  const cast = detectCast(access.rootCall);

  const { trust, reason: trustReason } = computeTrust({
    bypass: access.bypass,
    castAnyUnknown: cast.anyUnknown,
    castConcrete: cast.concrete,
    typedClient,
    specificSelect: chain.specificSelect,
  });

  const source = sourceFrom(access.rootCall, repoPath, sf);
  const sourceScope = classifySourceScope(source.filePath);
  const id = `touch:ts:${source.filePath}:${access.rootCall.getStartLineNumber()}:${tableName}`;
  const notes = buildNotes({
    direction: chain.direction,
    tableName,
    trust,
    bypass: access.bypass,
    castConcrete: cast.concrete,
    castText: cast.castText,
    castAnyUnknown: cast.anyUnknown,
    typedClient,
    specificSelect: chain.specificSelect,
  });

  return { id, direction: chain.direction, trust, trustReason, sourceScope, source, notes };
}

// 1. Table name + whether the access bypassed the type system.
function resolveTableName(arg: Node | undefined): TableArg {
  const lit = literalString(unwrapParens(arg));
  if (lit !== undefined) return { name: lit, bypass: false };

  const unwrapped = unwrapParens(arg);
  if (unwrapped && Node.isAsExpression(unwrapped)) {
    const inner = literalString(unwrapParens(unwrapped.getExpression()));
    if (inner === undefined) return { bypass: false };
    const typeText = unwrapped.getTypeNode()?.getText().trim() ?? '';
    return { name: inner, bypass: ANY_LIKE.test(typeText) };
  }
  return { bypass: false };
}

// 2. Direction + 5. select shape — walk downstream from `.from(...)`.
function analyzeChain(fromCall: CallExpression): {
  direction: EdgeDirection;
  specificSelect: boolean;
} {
  const methods: string[] = [];
  let selectArg: string | null = null;

  let current: Node = fromCall;
  for (;;) {
    const parent = current.getParent();
    if (!parent || !Node.isPropertyAccessExpression(parent) || parent.getExpression() !== current) {
      break;
    }
    const grandparent = parent.getParent();
    if (
      !grandparent ||
      !Node.isCallExpression(grandparent) ||
      grandparent.getExpression() !== parent
    ) {
      break;
    }
    const method = parent.getName();
    methods.push(method);
    if (method === 'select') {
      const a = grandparent.getArguments()[0];
      selectArg = a ? (literalString(a) ?? '*') : '*';
    }
    current = grandparent;
  }

  const direction: EdgeDirection = methods.some((m) => WRITE_METHODS.has(m)) ? 'write' : 'read';
  const specificSelect = selectArg !== null && selectArg.trim() !== '' && !selectArg.includes('*');
  return { direction, specificSelect };
}

// 3. Client type — is the receiver a genuinely-typed SupabaseClient<Database>?
// Conservative: anything we can't confirm as typed is treated as loose, which
// (per the honesty bias) pushes toward `dark` rather than `verified`.
//
// The receiver's type is resolved STRUCTURALLY (symbol + type arguments), not by
// its printed text. That matters because a type alias —
// `type Admin = SupabaseClient<Database>` — prints as `Admin` in getText(), so a
// naive substring check sees neither "SupabaseClient" nor "Database" and falsely
// reports `dark`. The class symbol + first type argument survive the alias (and
// alias chains), giving the SAME guarantee as writing the type inline. This must
// NOT loosen anything: a bare `SupabaseClient` (DB defaults to `any`), an explicit
// `<any>`, or an intersection with a bare arm all stay un-typed.
// Exported so the real-repo verify script can assert this exact function against
// behavioral ground truth (the `.from()` query-builder result) — not a copy.
export function isTypedClient(fromCall: CallExpression): boolean {
  const expr = fromCall.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return false;
  const receiver = expr.getExpression();
  try {
    return isTypedClientType(receiver.getType(), receiver);
  } catch {
    return false;
  }
}

// A receiver is typed iff its resolved type is `SupabaseClient<Database>` with a
// concrete (non-`any`) schema argument. Intersections are typed only if every
// SupabaseClient-bearing arm is itself typed — a single bare arm (e.g.
// `SupabaseClient & SupabaseClient<Database>`) reopens untyped access and is the
// real lie pattern, so it must stay dark/asserted.
function isTypedClientType(type: Type, node: Node, depth = 0): boolean {
  if (depth > 12) return false; // pathological alias chain — refuse to guess.

  if (type.isIntersection()) {
    let hasTyped = false;
    for (const arm of type.getIntersectionTypes()) {
      const mentionsClient =
        arm.getSymbol()?.getName() === 'SupabaseClient' ||
        arm.getText(node).includes('SupabaseClient');
      if (!mentionsClient) continue; // unrelated arm (e.g. `& { extra: true }`).
      if (isTypedClientType(arm, node, depth + 1)) hasTyped = true;
      else return false; // a SupabaseClient arm that isn't typed reopens access.
    }
    return hasTyped;
  }

  // getSymbol() resolves THROUGH type aliases to the underlying class symbol,
  // and getTypeArguments() exposes the real generic args — both unaffected by the
  // alias name that getText() would print. The client is typed iff its first
  // type argument (the database schema) is a concrete type, NOT `any`. A bare
  // `SupabaseClient` defaults that argument to `any`, so it (and any alias to it)
  // is correctly rejected. Verified against the real `.from()` query-builder
  // result: a concrete first arg is exactly the case where the compiler carries
  // the schema into the query (typed result); `any` yields an untyped result.
  if (type.getSymbol()?.getName() === 'SupabaseClient') {
    const args = type.getTypeArguments();
    if (args.length === 0) return false; // bare `SupabaseClient` → DB defaults to any.
    const db = args[0];
    if (db.isAny()) return false; // bare / explicit `SupabaseClient<any>` → not typed.
    return !ANY_LIKE.test(db.getText(node).trim()); // unknown/never are not a schema.
  }

  return false; // symbol didn't resolve to the client class — can't confirm typed.
}

// 4. Cast detection (heuristic, scoped to the local block). Looks for an
// `as X` applied either directly to the query chain or to the variable that the
// destructured `data` (or the whole result) is bound to. Inner casts of a
// double-cast (`as unknown as X`) are ignored in favor of the outer type.
function detectCast(fromCall: CallExpression): {
  concrete: boolean;
  anyUnknown: boolean;
  castText?: string;
} {
  const scope =
    fromCall.getFirstAncestorByKind(SyntaxKind.Block) ??
    fromCall.getFirstAncestorByKind(SyntaxKind.SourceFile);
  const resultVar = resultVarName(fromCall);

  let concrete = false;
  let anyUnknown = false;
  let castText: string | undefined;

  const casts = scope ? scope.getDescendantsOfKind(SyntaxKind.AsExpression) : [];
  for (const as of casts) {
    if (Node.isAsExpression(as.getParent())) continue; // inner of a double-cast

    const appliesToResult =
      isAncestorOf(as, fromCall) ||
      (resultVar !== undefined && referencesIdentifier(as.getExpression(), resultVar));
    if (!appliesToResult) continue;

    const typeText = as.getTypeNode()?.getText().trim() ?? '';
    if (ANY_LIKE.test(typeText)) {
      anyUnknown = true;
    } else {
      concrete = true;
      castText = typeText;
    }
  }
  return { concrete, anyUnknown, castText };
}

// TRUST — first match wins, in the spec's priority order. `asserted` is checked
// before the loose-client `dark` because a concrete cast on a loose client is
// still asserted, not dark.
function computeTrust(input: {
  bypass: boolean;
  castAnyUnknown: boolean;
  castConcrete: boolean;
  typedClient: boolean;
  specificSelect: boolean;
}): { trust: Trust; reason: TrustReason } {
  if (input.bypass) return { trust: 'dark', reason: 'ts-bypass-any' };
  if (input.castAnyUnknown) return { trust: 'dark', reason: 'ts-cast-any' };
  if (input.castConcrete) return { trust: 'asserted', reason: 'ts-cast-concrete' };
  if (!input.typedClient) return { trust: 'dark', reason: 'ts-loose-client' };
  if (input.specificSelect) return { trust: 'narrowed', reason: 'ts-narrowed-select' };
  return { trust: 'verified', reason: 'ts-verified' };
}

function buildNotes(input: {
  direction: EdgeDirection;
  tableName: string;
  trust: Trust;
  bypass: boolean;
  castConcrete: boolean;
  castText?: string;
  castAnyUnknown: boolean;
  typedClient: boolean;
  specificSelect: boolean;
}): string {
  const verb = input.direction === 'write' ? 'Write' : 'Read';
  const head = `${verb} of \`${input.tableName}\``;
  switch (input.trust) {
    case 'asserted':
      return `${head}, result cast \`as ${input.castText ?? 'X'}\` — asserted, not verified.`;
    case 'dark':
      if (input.bypass) return `${head} — table name cast \`as any\`, bypassing the type system — dark.`;
      if (input.castAnyUnknown) return `${head}, result cast to \`any\`/\`unknown\` — dark, type erased.`;
      return `${head} via a loosely-typed client (no \`SupabaseClient<Database>\`) — dark, type not carried.`;
    case 'narrowed':
      return `${head} on a typed client with a specific column select — narrowed, some fields dropped.`;
    case 'verified':
      return `${head} on a typed client, full select, no cast — verified.`;
  }
}

// ---------------------------------------------------------------------------
// Source grounding
// ---------------------------------------------------------------------------

function sourceFrom(fromCall: CallExpression, repoPath: string, sf: SourceFile): SourceRef {
  let node: Node = enclosingStatement(fromCall);
  // Avoid giant snippets (e.g. a `.from()` buried in a large JSX return) by
  // falling back to the fluent chain expression itself.
  if (node.getEndLineNumber() - node.getStartLineNumber() > 15) {
    node = outermostChainCall(fromCall);
  }
  // getText() begins at the node, dropping the first line's indentation; prepend
  // it back so the snippet lines up byte-for-byte with the real file.
  const indent = sf.getFullText().slice(node.getStartLinePos(), node.getStart());
  const snippet = /^\s*$/.test(indent) ? indent + node.getText() : node.getText();
  return {
    language: 'typescript',
    filePath: path.relative(repoPath, sf.getFilePath()),
    startLine: node.getStartLineNumber(),
    endLine: node.getEndLineNumber(),
    snippet,
  };
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function resultVarName(fromCall: CallExpression): string | undefined {
  const decl = fromCall.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  if (!decl) return undefined;
  const nameNode = decl.getNameNode();
  if (Node.isIdentifier(nameNode)) return nameNode.getText();
  if (Node.isObjectBindingPattern(nameNode)) {
    for (const el of nameNode.getElements()) {
      const prop = el.getPropertyNameNode()?.getText() ?? el.getNameNode().getText();
      if (prop === 'data') return el.getNameNode().getText();
    }
  }
  return undefined;
}

function referencesIdentifier(node: Node, name: string): boolean {
  if (Node.isIdentifier(node) && node.getText() === name) return true;
  return node.getDescendantsOfKind(SyntaxKind.Identifier).some((id) => id.getText() === name);
}

function isAncestorOf(ancestor: Node, descendant: Node): boolean {
  return descendant.getAncestors().includes(ancestor);
}

function outermostChainCall(fromCall: CallExpression): Node {
  let current: Node = fromCall;
  for (;;) {
    const parent = current.getParent();
    if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === current) {
      const gp = parent.getParent();
      if (gp && Node.isCallExpression(gp) && gp.getExpression() === parent) {
        current = gp;
        continue;
      }
    }
    break;
  }
  return current;
}

function enclosingStatement(node: Node): Node {
  let current: Node | undefined = node.getParent();
  while (current) {
    if (current.getKindName().endsWith('Statement')) return current;
    current = current.getParent();
  }
  return node;
}

function unwrapParens(node: Node | undefined): Node | undefined {
  let current = node;
  while (current && Node.isParenthesizedExpression(current)) {
    current = current.getExpression();
  }
  return current;
}

function literalString(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (Node.isStringLiteral(node)) return node.getLiteralValue();
  if (Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText();
  return undefined;
}

function uniqueId(id: string, used: Set<string>): string {
  if (!used.has(id)) {
    used.add(id);
    return id;
  }
  let i = 2;
  while (used.has(`${id}#${i}`)) i += 1;
  const next = `${id}#${i}`;
  used.add(next);
  return next;
}

function tally<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0].slice(0, 120);
}
