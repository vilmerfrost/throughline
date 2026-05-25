import { readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { ContractColumn, DriftFinding, DriftKind, GraphNode, SchemaMatch, SourceRef } from '@throughline/core';
import { parseRustSource, type RustNode } from './parseRust.js';
import { compareWriteFields } from '../schema/compareFields.js';
import { fixabilityFor, recommendedActionFor } from '../drift/detect.js';

// Deep-parse Rust write sites and compare the SERIALIZED FIELDS of each write
// against the SQL schema. This replaces the shallow "all Rust writes are blind"
// stance with a real, struct-vs-schema verdict — but only as the additive
// `schemaMatch` axis; the displayed `trust` is left alone (Stage 1a).
//
// Resolution is deliberately conservative. We trace the value handed to `.json()`
// LOCALLY within the write function (following one hop into a local builder's
// return type), and resolve it to a concrete field set ONLY when it is:
//   - a `#[derive(Serialize)]` struct (literal, or a builder fn returning one), or
//   - a `serde_json::json!({ ..literal keys.. })` payload.
// Anything dynamic (HashMap, conditional, a builder returning serde_json::Value,
// `#[serde(flatten)]`) stays `dark`. We never guess, and never claim a column is
// missing/extra unless the fields were actually resolved.

const WRITE_VERBS: Record<string, RustWriteSite['verb']> = {
  post: 'insert',
  patch: 'update',
  put: 'update',
  delete: 'delete',
};

const REST_PATH = /\/rest\/v1\/([a-z_][a-z0-9_]*)/;

export interface ResolvedBody {
  kind: 'struct' | 'json';
  structName?: string;
  keys: string[]; // serialized keys, in declaration order (after #[serde(rename)])
  nullableKeys: string[]; // subset that are Option<T> — informational
  // Keys whose presence in the serialized payload is CONDITIONAL —
  // `#[serde(skip_serializing_if = "…")]` etc. They appear in `keys` for
  // best-effort presence, but the comparison must NOT count them as
  // unconditionally present for required NOT-NULL columns.
  conditionalKeys: string[];
}

export interface RustWriteSite {
  table: string;
  verb: 'insert' | 'update' | 'delete';
  urlLine: number; // 1-based line of the /rest/v1 path string — matches the shallow touch
  schemaMatch: SchemaMatch;
  resolved: ResolvedBody | null; // null ⇔ dark
  source: SourceRef;
  drift: DriftFinding[]; // column-level findings, emitted ONLY on a resolved mismatch
}

// A struct definition resolved to its serialized field set. `resolvable: false`
// means the struct uses something we can't see through (e.g. #[serde(flatten)]).
interface StructDef {
  name: string;
  serialize: boolean;
  resolvable: boolean;
  fields: Array<{ key: string; nullable: boolean; conditional: boolean }>;
}

export async function analyzeRustSource(
  code: string,
  contracts: GraphNode[],
  filePath = 'src/lib.rs',
): Promise<RustWriteSite[]> {
  const tree = await parseRustSource(code);
  const root = tree.rootNode;
  const contractByTable = new Map(contracts.map((c) => [c.label, c]));
  const structs = indexStructs(root);
  const fns = indexFunctions(root);

  const sites: RustWriteSite[] = [];
  for (const verbCall of findVerbCalls(root)) {
    const verb = WRITE_VERBS[verbCall.fieldName];
    if (!verb) continue;

    const block = enclosingBlock(verbCall.node);
    const url = resolveUrl(firstArg(verbCall.node), block);
    if (!url) continue;
    const m = REST_PATH.exec(url.text);
    if (!m) continue;
    const table = m[1];
    const contract = contractByTable.get(table);
    if (!contract) continue; // only tables Throughline knows as contracts

    const chainTop = outermostChain(verbCall.node);
    const jsonArg = findJsonArg(chainTop);
    const resolved = jsonArg ? resolveBody(jsonArg, block, structs, fns) : null;

    const source = sourceFrom(chainTop, filePath);
    const { schemaMatch, missing, unknown, conditional } = compare(resolved, verb, contract.columns ?? []);
    const drift = buildDrift(contract, table, verb, resolved, missing, unknown, conditional, source);

    sites.push({ table, verb, urlLine: url.line, schemaMatch, resolved, source, drift });
  }
  return sites;
}

// Walk a repo's .rs files and analyze every Rust write site. The companion to
// the shallow grep pass: grep produces the (dark) touch nodes; this produces the
// additive schemaMatch verdict + grounded column-level drift findings.
export async function analyzeRustWrites(
  repoPath: string,
  contracts: GraphNode[],
): Promise<RustWriteSite[]> {
  const files = await walkRustFiles(repoPath);
  const out: RustWriteSite[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (!content.includes('/rest/v1/')) continue; // cheap skip: no PostgREST writes
    const rel = path.relative(repoPath, file);
    out.push(...(await analyzeRustSource(content, contracts, rel)));
  }
  return out;
}

// Match each deep-parsed write site back to the shallow Rust WRITE touch it
// describes and stamp its schemaMatch onto the node (additive — `trust` is left
// untouched). Touches and sites are joined by file + table + nearest line, since
// both derive the line from the same `/rest/v1/<table>` string.
const LINE_TOLERANCE = 40;

export function attachSchemaMatch(touches: GraphNode[], sites: RustWriteSite[]): void {
  for (const touch of touches) {
    if (touch.language !== 'rust' || !touch.source) continue;
    const [direction, table] = splitLabel(touch.label);
    if (direction !== 'write') continue;

    let best: RustWriteSite | null = null;
    let bestDelta = Infinity;
    for (const s of sites) {
      if (s.table !== table || s.source.filePath !== touch.source.filePath) continue;
      const delta = Math.abs(s.urlLine - touch.source.startLine);
      if (delta < bestDelta) {
        best = s;
        bestDelta = delta;
      }
    }
    if (best && bestDelta <= LINE_TOLERANCE) {
      touch.schemaMatch = best.schemaMatch;
      // When we actually resolved the payload (aligned/mismatch) we DID see
      // the struct fields — upgrade the per-touch analysisDepth so consumers
      // know this touch has more than shallow-grep evidence. Trust stays
      // untouched: deep parsing is NOT compiler verification.
      if (best.schemaMatch !== 'dark') touch.analysisDepth = 'deep';
      else touch.analysisDepth = 'analyzer_limit';
    }
  }
}

function splitLabel(label: string): [string, string] {
  const i = label.indexOf(' ');
  return i < 0 ? [label, ''] : [label.slice(0, i), label.slice(i + 1)];
}

const SKIP_DIRS = new Set([
  'node_modules', '.next', 'dist', 'out', 'build', 'target', '__pycache__',
  '.venv', 'venv', 'models', 'training_data', '.git',
]);

async function walkRustFiles(repoPath: string): Promise<string[]> {
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
    } else if (entry.isFile() && entry.name.endsWith('.rs')) {
      out.push(full);
    }
  }
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

// An unresolved payload is `dark` (no name-level claim possible); otherwise we
// delegate the name-vs-schema verdict to the ONE shared comparison that
// check_write also uses, so the two can never disagree. For Rust we ALSO
// emit a `conditional` list: NOT-NULL-no-default columns whose only struct
// field is `#[serde(skip_serializing_if = "…")]` — present in `keys` but not
// guaranteed at runtime. These never flip the schema verdict (the field IS
// declared); they only surface as a softer drift finding.
function compare(
  resolved: ResolvedBody | null,
  verb: RustWriteSite['verb'],
  columns: ContractColumn[],
): { schemaMatch: SchemaMatch; missing: string[]; unknown: string[]; conditional: string[] } {
  if (!resolved) return { schemaMatch: 'dark', missing: [], unknown: [], conditional: [] };
  const r = compareWriteFields(resolved.keys, verb, columns);
  const conditional =
    verb === 'insert'
      ? columns
          .filter((c) => c.nullable === false && !c.hasDefault && resolved.conditionalKeys.includes(c.name))
          .map((c) => c.name)
      : [];
  return {
    schemaMatch: r.schemaMatch,
    missing: r.missingRequired,
    unknown: r.unknownKeys,
    conditional,
  };
}

function buildDrift(
  contract: GraphNode,
  table: string,
  verb: RustWriteSite['verb'],
  resolved: ResolvedBody | null,
  missing: string[],
  unknown: string[],
  conditional: string[],
  source: SourceRef,
): DriftFinding[] {
  if (!resolved) return []; // unresolved → never a column-level claim
  const origin = resolved.structName ? `built from struct \`${resolved.structName}\`` : 'free-form payload';
  const findings: DriftFinding[] = [];
  for (const col of missing) {
    findings.push(taggedFinding(contract, source, 'warn',
      `Rust ${verb} of \`${table}\` omits NOT-NULL column \`${col}\` (${origin}).`,
      'rust-missing-required-column'));
  }
  for (const key of unknown) {
    findings.push(taggedFinding(contract, source, 'warn',
      `Rust ${verb} of \`${table}\` writes unknown key \`${key}\` not in the schema (${origin}).`,
      'rust-unknown-key'));
  }
  // `skip_serializing_if` on a NOT-NULL-no-default column: the field exists,
  // so this is not a `mismatch`, but the runtime payload may omit it. Emit
  // an info-level finding so consumers can see the risk without overclaiming.
  for (const col of conditional) {
    findings.push(taggedFinding(contract, source, 'info',
      `Rust ${verb} of \`${table}\` may conditionally omit NOT-NULL column \`${col}\` ` +
        `(${origin}; field carries \`#[serde(skip_serializing_if = …)]\`).`,
      'rust-conditional-serialization'));
  }
  return findings;
}

function taggedFinding(
  contract: GraphNode,
  source: SourceRef,
  severity: DriftFinding['severity'],
  message: string,
  kind: DriftKind,
): DriftFinding {
  return {
    contractId: contract.id,
    severity,
    message,
    source,
    kind,
    fixability: fixabilityFor(kind),
    recommendedAction: recommendedActionFor(kind),
  };
}

// ---------------------------------------------------------------------------
// Body resolution: trace the `.json(<arg>)` value to a concrete field set
// ---------------------------------------------------------------------------

function resolveBody(
  arg: RustNode,
  block: RustNode | null,
  structs: Map<string, StructDef>,
  fns: Map<string, string | null>,
): ResolvedBody | null {
  const expr = unwrapRef(arg);
  if (!expr) return null;

  switch (expr.type) {
    case 'identifier': {
      const init = block ? findLetValue(block, expr.text) : null;
      return init ? resolveBody(init, block, structs, fns) : null;
    }
    case 'macro_invocation':
      return resolveJsonMacro(expr);
    case 'struct_expression': {
      const name = baseTypeName(expr.childForFieldName('name'));
      return name ? resolveStruct(name, structs) : null;
    }
    case 'call_expression': {
      const fn = expr.childForFieldName('function');
      const callee = fn ? calleeName(fn) : null;
      // serde_json::to_value(&x) just forwards x to serialization.
      if (callee === 'to_value' || callee === 'to_value_pretty') {
        const inner = firstArg(expr);
        return inner ? resolveBody(inner, block, structs, fns) : null;
      }
      if (!callee || !fns.has(callee)) return null;
      const returnType = fns.get(callee) ?? null;
      return returnType ? resolveStruct(returnType, structs) : null;
    }
    default:
      return null;
  }
}

function resolveStruct(name: string, structs: Map<string, StructDef>): ResolvedBody | null {
  const def = structs.get(name);
  if (!def || !def.serialize || !def.resolvable) return null;
  return {
    kind: 'struct',
    structName: name,
    keys: def.fields.map((f) => f.key),
    nullableKeys: def.fields.filter((f) => f.nullable).map((f) => f.key),
    conditionalKeys: def.fields.filter((f) => f.conditional).map((f) => f.key),
  };
}

function resolveJsonMacro(macro: RustNode): ResolvedBody | null {
  const path = macroPath(macro);
  if (!path || !/(^|::)json$/.test(path)) return null; // only serde_json::json! / json!
  const obj = objectTokenTree(macro);
  if (!obj) return null;
  const keys: string[] = [];
  const kids = obj.children;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    // A top-level key is a string literal immediately followed by `:`.
    if (k.type === 'string_literal' && kids[i + 1]?.type === ':') {
      keys.push(stripQuotes(k.text));
    }
  }
  return { kind: 'json', keys, nullableKeys: [], conditionalKeys: [] };
}

// ---------------------------------------------------------------------------
// Indexing structs and functions
// ---------------------------------------------------------------------------

function indexStructs(root: RustNode): Map<string, StructDef> {
  const out = new Map<string, StructDef>();
  for (const node of descendants(root)) {
    if (node.type !== 'struct_item') continue;
    const name = node.childForFieldName('name')?.text;
    if (!name) continue;
    out.set(name, readStruct(name, node));
  }
  return out;
}

function readStruct(name: string, node: RustNode): StructDef {
  const serialize = hasSerializeDerive(node);
  const list = node.childForFieldName('body') ?? findChild(node, 'field_declaration_list');
  const fields: StructDef['fields'] = [];
  let resolvable = true;
  let pendingAttrs: string[] = [];

  if (list) {
    for (const child of list.namedChildren) {
      if (child.type === 'attribute_item') {
        pendingAttrs.push(child.text);
        continue;
      }
      if (child.type !== 'field_declaration') {
        pendingAttrs = [];
        continue;
      }
      const attrs = pendingAttrs;
      pendingAttrs = [];
      const serde = parseSerdeFieldAttrs(attrs);
      if (serde.flatten) {
        resolvable = false; // flattened keys are invisible to us — don't guess
        continue;
      }
      if (serde.skip) continue;
      const fieldName = child.childForFieldName('name')?.text;
      if (!fieldName) continue;
      const typeNode = child.childForFieldName('type');
      fields.push({
        key: serde.rename ?? fieldName,
        nullable: isOption(typeNode),
        // `skip_serializing_if = "…"` means presence is conditional at runtime.
        // We keep the key (best-effort) but track it so the comparison won't
        // treat a NOT-NULL-no-default column as guaranteed-present from a
        // conditional field.
        conditional: serde.skipIf,
      });
    }
  }
  return { name, serialize, resolvable, fields };
}

function hasSerializeDerive(structNode: RustNode): boolean {
  let prev = structNode.previousNamedSibling;
  while (prev && prev.type === 'attribute_item') {
    if (/derive\s*\([^)]*\bSerialize\b/.test(prev.text)) return true;
    prev = prev.previousNamedSibling;
  }
  return false;
}

function parseSerdeFieldAttrs(attrs: string[]): { rename?: string; skip: boolean; flatten: boolean; skipIf: boolean } {
  let rename: string | undefined;
  let skip = false;
  let flatten = false;
  let skipIf = false;
  for (const a of attrs) {
    if (!/\bserde\b/.test(a)) continue;
    const r = /\brename\s*=\s*"([^"]+)"/.exec(a);
    if (r) rename = r[1];
    if (/\bflatten\b/.test(a)) flatten = true;
    // `skip_serializing_if` makes the field's presence CONDITIONAL — we keep
    // the key (best-effort) but mark it conditional so the compare doesn't
    // overclaim "required column is present" when it might be skipped.
    if (/\bskip_serializing_if\b/.test(a)) skipIf = true;
    // `skip` / `skip_serializing` (without `_if`) unconditionally drops the
    // field. Detect with a negative lookbehind so `skip_serializing_if` is not
    // collapsed into the unconditional bucket.
    if (/\bskip\b(?!_)/.test(a) || /\bskip_serializing\b(?!_)/.test(a)) skip = true;
  }
  return { rename, skip, flatten, skipIf };
}

function isOption(typeNode: RustNode | null): boolean {
  if (!typeNode) return false;
  if (typeNode.type === 'generic_type') {
    return typeNode.childForFieldName('type')?.text === 'Option';
  }
  return false;
}

function indexFunctions(root: RustNode): Map<string, string | null> {
  // fn name → base identifier of its return type (null if no/!-resolvable return)
  const out = new Map<string, string | null>();
  for (const node of descendants(root)) {
    if (node.type !== 'function_item') continue;
    const name = node.childForFieldName('name')?.text;
    if (!name) continue;
    out.set(name, baseTypeName(node.childForFieldName('return_type')));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Write-site / chain helpers
// ---------------------------------------------------------------------------

function findVerbCalls(root: RustNode): Array<{ node: RustNode; fieldName: string }> {
  const out: Array<{ node: RustNode; fieldName: string }> = [];
  for (const node of descendants(root)) {
    if (node.type !== 'call_expression') continue;
    const fn = node.childForFieldName('function');
    if (!fn || fn.type !== 'field_expression') continue;
    const field = fn.childForFieldName('field')?.text;
    if (field && field in WRITE_VERBS) out.push({ node, fieldName: field });
  }
  return out;
}

// Climb to the top of the fluent chain (e.g. the outer `.send()`/`.await`).
function outermostChain(call: RustNode): RustNode {
  let top = call;
  let n: RustNode | null = call.parent;
  while (n) {
    if (
      n.type === 'call_expression' ||
      n.type === 'field_expression' ||
      n.type === 'await_expression' ||
      n.type === 'try_expression'
    ) {
      if (n.type === 'call_expression') top = n;
      n = n.parent;
    } else break;
  }
  return top;
}

// The `.json(<arg>)` argument anywhere inside the chain, or null.
function findJsonArg(chainTop: RustNode): RustNode | null {
  for (const node of descendants(chainTop)) {
    if (node.type !== 'call_expression') continue;
    const fn = node.childForFieldName('function');
    if (fn?.type === 'field_expression' && fn.childForFieldName('field')?.text === 'json') {
      return firstArg(node);
    }
  }
  return null;
}

function resolveUrl(arg: RustNode | null, block: RustNode | null): { text: string; line: number } | null {
  const expr = unwrapRef(arg);
  if (!expr) return null;
  if (expr.type === 'identifier') {
    const init = block ? findLetValue(block, expr.text) : null;
    return init ? resolveUrl(init, block) : null;
  }
  // macro_invocation (format!), string_literal, etc.: search its text for the path.
  if (!REST_PATH.test(expr.text)) return null;
  const lit = findRestStringLiteral(expr);
  const line = (lit ?? expr).startPosition.row + 1;
  return { text: expr.text, line };
}

function findRestStringLiteral(node: RustNode): RustNode | null {
  for (const d of descendants(node)) {
    if ((d.type === 'string_literal' || d.type === 'raw_string_literal') && REST_PATH.test(d.text)) {
      return d;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Low-level AST utilities
// ---------------------------------------------------------------------------

function firstArg(call: RustNode): RustNode | null {
  const args = call.childForFieldName('arguments');
  return args?.namedChildren[0] ?? null;
}

function unwrapRef(node: RustNode | null): RustNode | null {
  let n = node;
  while (n && n.type === 'reference_expression') {
    n = n.childForFieldName('value') ?? n.namedChildren[0] ?? null;
  }
  return n;
}

// First `let <name> = <value>` in the block (functions are small; first wins).
function findLetValue(block: RustNode, name: string): RustNode | null {
  for (const node of descendants(block)) {
    if (node.type !== 'let_declaration') continue;
    if (node.childForFieldName('pattern')?.text === name) {
      return node.childForFieldName('value');
    }
  }
  return null;
}

function enclosingBlock(node: RustNode): RustNode | null {
  let n: RustNode | null = node.parent;
  while (n) {
    if (n.type === 'block') return n;
    n = n.parent;
  }
  return null;
}

// Base identifier of a type node: Option<&str> → "Option", serde_json::Value →
// "Value", BatchInsertPayload<'a> → "BatchInsertPayload", &T → base of T.
function baseTypeName(typeNode: RustNode | null): string | null {
  if (!typeNode) return null;
  switch (typeNode.type) {
    case 'type_identifier':
      return typeNode.text;
    case 'generic_type':
      return baseTypeName(typeNode.childForFieldName('type'));
    case 'reference_type':
      return baseTypeName(typeNode.childForFieldName('type'));
    case 'scoped_type_identifier':
      return typeNode.childForFieldName('name')?.text ?? null;
    default:
      return null;
  }
}

// Last segment of a call target: build_x() → "build_x", Self::build_x → "build_x".
function calleeName(fn: RustNode): string | null {
  switch (fn.type) {
    case 'identifier':
      return fn.text;
    case 'scoped_identifier':
      return fn.childForFieldName('name')?.text ?? null;
    case 'field_expression':
      return fn.childForFieldName('field')?.text ?? null;
    case 'generic_function':
      return calleeName(fn.childForFieldName('function') ?? fn);
    default:
      return null;
  }
}

function macroPath(macro: RustNode): string | null {
  for (const c of macro.namedChildren) {
    if (c.type === 'identifier' || c.type === 'scoped_identifier') return c.text;
  }
  return macro.childForFieldName('macro')?.text ?? null;
}

// The `{ ... }` object token tree inside a json!(...) macro.
function objectTokenTree(macro: RustNode): RustNode | null {
  for (const d of descendants(macro)) {
    if (d.type === 'token_tree' && d.text.trimStart().startsWith('{')) return d;
  }
  return null;
}

function stripQuotes(s: string): string {
  return s.replace(/^[a-z]?"/, '').replace(/"$/, '');
}

function sourceFrom(node: RustNode, filePath: string): SourceRef {
  const text = node.text;
  const snippet = text.length > 600 ? `${text.slice(0, 600)}…` : text;
  return {
    language: 'rust',
    filePath,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    snippet,
  };
}

function findChild(node: RustNode, type: string): RustNode | null {
  for (const c of node.namedChildren) if (c.type === type) return c;
  return null;
}

function* descendants(node: RustNode): Generator<RustNode> {
  const stack: RustNode[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    yield n;
    for (let i = n.childCount - 1; i >= 0; i--) {
      const c = n.child(i);
      if (c) stack.push(c);
    }
  }
}
