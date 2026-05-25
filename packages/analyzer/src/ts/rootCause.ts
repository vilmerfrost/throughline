import path from 'node:path';
import { Node, SyntaxKind, type CallExpression, type Symbol as TsSymbol } from 'ts-morph';
import type {
  RootCause,
  RootCauseOrigin,
  SourceRef,
  SourceScope,
  TrustReason,
  UnresolvedShape,
} from '@throughline/core';

// RC-a: deterministic root-cause rollup.
//
// Two pure, side-effect-free steps, no LLM anywhere:
//   1. resolveClientOrigin — follow the `.from(...)` receiver's symbol to the
//      construction site that built the client (ts-morph). Never guesses: when
//      the trace dead-ends it returns the literal 'unresolved-origin'.
//   2. rollupRootCauses — group already-computed per-touch facts by
//      (reason, origin) and rank biggest-lever-first.

export const UNRESOLVED_ORIGIN = 'unresolved-origin';

// One dark/asserted touch's facts, fed into the rollup. The TS analyzer already
// knows all of these — the rollup invents nothing.
export interface RootCauseInput {
  touchId: string;
  reason: TrustReason;
  contract: string; // the contract (table) label this touch hits
  origin: RootCauseOrigin;
  // RC-a addendum: a real grounding ref for unresolved touches (e.g. the
  // function signature for the 'parameter' shape). Sampled into RootCause.evidence.
  evidence?: SourceRef;
  sourceScope?: SourceScope;
}

// How many representative grounding refs to keep per unresolved group.
const EVIDENCE_CAP = 3;

// ---------------------------------------------------------------------------
// Step 2: pure grouping (no ts-morph)
// ---------------------------------------------------------------------------

export function rollupRootCauses(inputs: RootCauseInput[]): RootCause[] {
  interface Group {
    reason: TrustReason;
    origin: RootCauseOrigin;
    touchIds: string[];
    contracts: Set<string>;
    evidence: SourceRef[];
    evidenceSeen: Set<string>;
    scopeBreakdown: Partial<Record<SourceScope, number>>;
  }
  const groups = new Map<string, Group>();

  for (const inp of inputs) {
    // Origin identity is the construction SITE, so two distinct `const sb =
    // createServerClient()` declarations stay separate levers. An unresolved
    // origin has no site, so it keys on (reason, name, SHAPE) — sub-grouping the
    // unresolved bucket by WHY it's unresolved instead of by a fake location.
    const loc = inp.origin.source
      ? `${inp.origin.source.filePath}:${inp.origin.source.startLine}`
      : `${UNRESOLVED_ORIGIN}:${inp.origin.shape ?? 'other'}`;
    const key = `${inp.reason}::${inp.origin.name}::${loc}`;

    let g = groups.get(key);
    if (!g) {
      g = {
        reason: inp.reason,
        origin: inp.origin,
        touchIds: [],
        contracts: new Set(),
        evidence: [],
        evidenceSeen: new Set(),
        scopeBreakdown: {},
      };
      groups.set(key, g);
    }
    g.touchIds.push(inp.touchId);
    g.contracts.add(inp.contract);
    const scope = inp.sourceScope ?? 'unknown';
    g.scopeBreakdown[scope] = (g.scopeBreakdown[scope] ?? 0) + 1;
    // Keep a capped, deduped sample of grounding refs (e.g. signatures).
    if (inp.evidence && g.evidence.length < EVIDENCE_CAP) {
      const ek = `${inp.evidence.filePath}:${inp.evidence.startLine}`;
      if (!g.evidenceSeen.has(ek)) {
        g.evidenceSeen.add(ek);
        g.evidence.push(inp.evidence);
      }
    }
  }

  const causes: RootCause[] = [...groups.values()].map((g) => ({
    reason: g.reason,
    origin: g.origin,
    affectedCount: g.touchIds.length,
    affectedTouchIds: g.touchIds,
    affectedContracts: [...g.contracts].sort(),
    scopeBreakdown: g.scopeBreakdown,
    productionImpact: (g.scopeBreakdown.production ?? 0) > 0,
    testOnly: Object.keys(g.scopeBreakdown).length === 1 && (g.scopeBreakdown.test ?? 0) > 0,
    ...(g.evidence.length ? { evidence: g.evidence } : {}),
  }));

  // Biggest lever first; deterministic tiebreak by origin name then reason.
  causes.sort(
    (a, b) =>
      b.affectedCount - a.affectedCount ||
      a.origin.name.localeCompare(b.origin.name) ||
      a.reason.localeCompare(b.reason),
  );
  return causes;
}

// ---------------------------------------------------------------------------
// Step 1: resolve the client origin via ts-morph
// ---------------------------------------------------------------------------

interface Construction {
  name: string; // the constructor/helper that built the client
  groundNode: Node; // where to ground the SourceRef (the construction site)
}

export function resolveClientOrigin(fromCall: CallExpression, repoPath: string): RootCauseOrigin {
  const expr = fromCall.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return { name: UNRESOLVED_ORIGIN };

  let construction: Construction | undefined;
  try {
    construction = findConstruction(expr.getExpression(), new Set());
  } catch {
    construction = undefined;
  }
  if (!construction) return { name: UNRESOLVED_ORIGIN };
  return { name: construction.name, source: sourceRefFromNode(construction.groundNode, repoPath) };
}

// ---------------------------------------------------------------------------
// Step 1b: classify WHY an unresolved touch couldn't be traced
// ---------------------------------------------------------------------------

// Structural and deterministic; returns 'other' on any uncertainty (never
// guesses). Only call this for touches whose origin came back unresolved.
export function classifyUnresolved(
  fromCall: CallExpression,
  repoPath: string,
): { shape: UnresolvedShape; evidence?: SourceRef } {
  const expr = fromCall.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return { shape: 'other' };
  try {
    return classifyReceiver(expr.getExpression(), repoPath, new Set());
  } catch {
    return { shape: 'other' };
  }
}

function classifyReceiver(
  node: Node | undefined,
  repoPath: string,
  visited: Set<string>,
): { shape: UnresolvedShape; evidence?: SourceRef } {
  const n = unwrap(node);
  if (!n) return { shape: 'other' };

  const key = `${n.getKindName()}:${n.getSourceFile().getFilePath()}:${n.getStart()}:${n.getEnd()}`;
  if (visited.has(key)) return { shape: 'other' };
  visited.add(key);

  // `someRef.current` — a ref/closure indirection.
  if (Node.isPropertyAccessExpression(n)) {
    if (n.getName() === 'current') return { shape: 'ref' };
    const sym = n.getNameNode().getSymbol() ?? n.getSymbol();
    for (const decl of symbolDeclarations(sym)) {
      const r = classifyDecl(decl, repoPath, visited);
      if (r) return r;
    }
    return { shape: 'other' };
  }

  if (Node.isIdentifier(n)) {
    const decls = symbolDeclarations(n.getSymbol());
    // A parameter is the most actionable shape — fix the signature.
    for (const decl of decls) {
      if (Node.isParameterDeclaration(decl)) {
        return { shape: 'parameter', evidence: signatureRef(decl, repoPath) };
      }
    }
    // An imported binding that we couldn't resolve to a construction is an
    // untyped imported singleton — the fix lives at its definition.
    const imported = decls.some(
      (d) =>
        Node.isImportSpecifier(d) ||
        Node.isImportClause(d) ||
        Node.isNamespaceImport(d) ||
        Node.isImportEqualsDeclaration(d),
    );
    if (imported) return { shape: 'imported-untyped' };
    // Local variable — trace into its initializer.
    for (const decl of decls) {
      const r = classifyDecl(decl, repoPath, visited);
      if (r) return r;
    }
    return { shape: 'other' };
  }

  if (Node.isCallExpression(n)) {
    const callee = unwrap(n.getExpression());
    // Method call on a client (e.g. `sb.schema()`) — classify the base object.
    if (callee && Node.isPropertyAccessExpression(callee)) {
      return classifyReceiver(callee.getExpression(), repoPath, visited);
    }
    return { shape: 'other' };
  }

  return { shape: 'other' };
}

function classifyDecl(
  decl: Node,
  repoPath: string,
  visited: Set<string>,
): { shape: UnresolvedShape; evidence?: SourceRef } | undefined {
  const init =
    Node.isVariableDeclaration(decl) || Node.isPropertyDeclaration(decl)
      ? decl.getInitializer()
      : undefined;
  if (!init) return undefined;
  const u = unwrap(init);
  if (u && Node.isPropertyAccessExpression(u) && u.getName() === 'current') return { shape: 'ref' };
  return classifyReceiver(init, repoPath, visited);
}

// The signature of the function that owns a parameter — the fix site. Snippet is
// the header only (up to the body), not the whole function.
function signatureRef(param: Node, repoPath: string): SourceRef | undefined {
  const fn = param.getFirstAncestor(
    (a) =>
      Node.isFunctionDeclaration(a) ||
      Node.isMethodDeclaration(a) ||
      Node.isArrowFunction(a) ||
      Node.isFunctionExpression(a) ||
      Node.isConstructorDeclaration(a),
  );
  const target = fn ?? param;
  const sf = target.getSourceFile();
  const body = fn && 'getBody' in fn ? (fn as { getBody?: () => Node | undefined }).getBody?.() : undefined;
  const startPos = target.getStart();
  const endPos = body ? body.getStart() : param.getEnd();
  const snippet = sf.getFullText().slice(startPos, Math.max(startPos, endPos)).trim();
  return {
    language: 'typescript',
    filePath: path.relative(repoPath, sf.getFilePath()),
    startLine: target.getStartLineNumber(),
    endLine: body ? body.getStartLineNumber() : param.getEndLineNumber(),
    snippet,
  };
}

// Walk from the `.from()` receiver to the call/`new` that constructed the client.
function findConstruction(node: Node | undefined, visited: Set<string>): Construction | undefined {
  const n = unwrap(node);
  if (!n) return undefined;

  // Cycle guard. Key must include kind AND span: a CallExpression and its
  // leftmost Identifier share getStart(), so a start-only key would wrongly
  // collide and block the very recursion we need (e.g. `sb.schema()` → `sb`).
  const key = `${n.getKindName()}:${n.getSourceFile().getFilePath()}:${n.getStart()}:${n.getEnd()}`;
  if (visited.has(key)) return undefined; // re-resolved symbol cycle guard
  visited.add(key);

  // `new SupabaseClient(...)`
  if (Node.isNewExpression(n)) {
    return { name: n.getExpression().getText(), groundNode: n };
  }

  if (Node.isCallExpression(n)) {
    const callee = unwrap(n.getExpression());
    // Factory/helper call: createServerClient(), createClient(), getClient()…
    if (callee && Node.isIdentifier(callee)) {
      return { name: callee.getText(), groundNode: n };
    }
    // Method call on something (e.g. `sb.schema('public')`): the construction is
    // the receiver, not this method — trace into the base object.
    if (callee && Node.isPropertyAccessExpression(callee)) {
      return findConstruction(callee.getExpression(), visited);
    }
    return undefined;
  }

  // A name: follow its symbol to a declaration that constructs the client.
  if (Node.isIdentifier(n)) {
    for (const decl of symbolDeclarations(n.getSymbol())) {
      const c = constructionFromDecl(decl, visited);
      if (c) return c;
    }
    return undefined;
  }

  // `this.supabase` / `clients.admin`: follow the property's symbol.
  if (Node.isPropertyAccessExpression(n)) {
    const sym = n.getNameNode().getSymbol() ?? n.getSymbol();
    for (const decl of symbolDeclarations(sym)) {
      const c = constructionFromDecl(decl, visited);
      if (c) return c;
    }
    return undefined;
  }

  return undefined;
}

function constructionFromDecl(decl: Node, visited: Set<string>): Construction | undefined {
  // `const sb = createServerClient()` — ground at the statement so the snippet
  // reads as the real construction site.
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (!init) return undefined;
    const inner = findConstruction(init, visited);
    if (!inner) return undefined;
    const stmt = decl.getFirstAncestorByKind(SyntaxKind.VariableStatement) ?? decl;
    return { name: inner.name, groundNode: stmt };
  }
  // class field: `private supabase = createClient()`
  if (Node.isPropertyDeclaration(decl)) {
    const init = decl.getInitializer();
    if (!init) return undefined;
    const inner = findConstruction(init, visited);
    if (!inner) return undefined;
    return { name: inner.name, groundNode: decl };
  }
  // Parameter, bare import binding, etc. — no construction visible here.
  return undefined;
}

// Declarations of a symbol, following import aliases so an imported singleton
// (`import { supabase } from '@/lib/supabase'`) resolves to its real `const`.
function symbolDeclarations(sym: TsSymbol | undefined): Node[] {
  if (!sym) return [];
  const out: Node[] = [...(sym.getDeclarations() ?? [])];
  try {
    const aliased = sym.getAliasedSymbol();
    if (aliased) out.push(...(aliased.getDeclarations() ?? []));
  } catch {
    /* not an alias */
  }
  return out;
}

function unwrap(node: Node | undefined): Node | undefined {
  let cur = node;
  for (;;) {
    if (!cur) return cur;
    if (Node.isParenthesizedExpression(cur) || Node.isAwaitExpression(cur)) {
      cur = cur.getExpression();
      continue;
    }
    if (Node.isAsExpression(cur) || Node.isNonNullExpression(cur)) {
      cur = cur.getExpression();
      continue;
    }
    return cur;
  }
}

function sourceRefFromNode(node: Node, repoPath: string): SourceRef {
  const sf = node.getSourceFile();
  // Prepend the first line's indentation so the snippet lines up with the file.
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
