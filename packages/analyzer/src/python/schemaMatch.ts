import { readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type {
  ContractColumn,
  DriftFinding,
  DriftKind,
  GraphNode,
  SchemaMatch,
  SourceRef,
} from '@throughline/core';
import { parsePythonSource, type PyNode } from './parsePython.js';
import { compareWriteFields } from '../schema/compareFields.js';
import { fixabilityFor, recommendedActionFor } from '../drift/detect.js';

// Deep-parse Python supabase-py write sites and compare the SERIALIZED FIELDS
// of each write against the SQL schema. Same intent as the Rust Stage 1a
// analyzer: stamp an additive `schemaMatch` verdict on the (still-dark) Python
// write touches and emit grounded column-level drift. Trust stays as-is.
//
// Resolution is deliberately conservative — same honesty bar as Rust:
//   - dict literal:    {"id": "x", "status": "queued"} → resolved keys
//   - local variable:  payload = {..}; .insert(payload).execute() → followed
//                      ONLY to a single `payload = {...}` in the same scope
//   - kwargs:          .insert(id="x", status="queued") → resolved keys
//   - list of dicts:   .insert([{"id": "a"}, {"id": "b"}]) → resolved (the
//                      union of literal keys); rows with non-literal keys make
//                      the whole site dark
//
// Anything dynamic (dict comprehension, dict() call with a variable, spread
// from `**other`, function-call payload that we don't see) stays `dark`.

const WRITE_VERBS: Record<string, PythonWriteSite['verb']> = {
  insert: 'insert',
  upsert: 'insert', // upsert presence-wise behaves like insert for required cols
  update: 'update',
  delete: 'delete',
};

export interface ResolvedBody {
  kind: 'dict' | 'kwargs';
  keys: string[]; // union of literal keys in declaration order
}

export interface PythonWriteSite {
  table: string;
  verb: 'insert' | 'update' | 'delete';
  callLine: number; // 1-based line of the `.insert(...)` call (matches the shallow touch)
  schemaMatch: SchemaMatch;
  resolved: ResolvedBody | null; // null ⇔ dark
  source: SourceRef;
  drift: DriftFinding[];
}

export async function analyzePythonSource(
  code: string,
  contracts: GraphNode[],
  filePath = 'app.py',
): Promise<PythonWriteSite[]> {
  const tree = await parsePythonSource(code);
  const root = tree.rootNode;
  const contractByTable = new Map(contracts.map((c) => [c.label, c]));

  const sites: PythonWriteSite[] = [];
  for (const writeCall of findWriteCalls(root)) {
    const table = resolveTableFromChain(writeCall.node);
    if (!table) continue;
    const contract = contractByTable.get(table);
    if (!contract) continue;

    const verb = writeCall.verb;
    const args = writeCall.node.childForFieldName('arguments');
    const resolved = args ? resolveBody(args, writeCall.scope) : null;

    const source = sourceFrom(writeCall.node, filePath);
    const { schemaMatch, missing, unknown } = compare(resolved, verb, contract.columns ?? []);
    const drift = buildDrift(contract, table, verb, resolved, missing, unknown, source);

    sites.push({
      table,
      verb,
      callLine: writeCall.node.startPosition.row + 1,
      schemaMatch,
      resolved,
      source,
      drift,
    });
  }
  return sites;
}

const SKIP_DIRS = new Set([
  'node_modules', '.next', 'dist', 'out', 'build', 'target', '__pycache__',
  '.venv', 'venv', 'models', 'training_data', '.git',
]);

export async function analyzePythonWrites(
  repoPath: string,
  contracts: GraphNode[],
): Promise<PythonWriteSite[]> {
  const files = await walkPyFiles(repoPath);
  const out: PythonWriteSite[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    // Cheap skip: a file with no `.table(` AND no `.from_(` cannot have a
    // supabase-py write we'd resolve.
    if (!content.includes('.table(') && !content.includes('.from_(')) continue;
    const rel = path.relative(repoPath, file);
    try {
      out.push(...(await analyzePythonSource(content, contracts, rel)));
    } catch {
      // tree-sitter very rarely raises; skip and keep going.
    }
  }
  return out;
}

async function walkPyFiles(repoPath: string): Promise<string[]> {
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
    } else if (entry.isFile() && entry.name.endsWith('.py')) {
      out.push(full);
    }
  }
}

// ---------------------------------------------------------------------------
// Attach to shallow touches (same shape as Rust attachSchemaMatch)
// ---------------------------------------------------------------------------

const LINE_TOLERANCE = 40;

export function attachPythonSchemaMatch(touches: GraphNode[], sites: PythonWriteSite[]): void {
  for (const touch of touches) {
    if (touch.language !== 'python' || !touch.source) continue;
    const [direction, table] = splitLabel(touch.label);
    if (direction !== 'write') continue;

    let best: PythonWriteSite | null = null;
    let bestDelta = Infinity;
    for (const s of sites) {
      if (s.table !== table || s.source.filePath !== touch.source.filePath) continue;
      const delta = Math.abs(s.callLine - touch.source.startLine);
      if (delta < bestDelta) {
        best = s;
        bestDelta = delta;
      }
    }
    if (best && bestDelta <= LINE_TOLERANCE) {
      touch.schemaMatch = best.schemaMatch;
      if (best.schemaMatch !== 'dark') touch.analysisDepth = 'deep';
      else touch.analysisDepth = 'analyzer_limit';
    }
  }
}

function splitLabel(label: string): [string, string] {
  const i = label.indexOf(' ');
  return i < 0 ? [label, ''] : [label.slice(0, i), label.slice(i + 1)];
}

// ---------------------------------------------------------------------------
// Comparison + drift findings (reuse shared compareWriteFields)
// ---------------------------------------------------------------------------

function compare(
  resolved: ResolvedBody | null,
  verb: PythonWriteSite['verb'],
  columns: ContractColumn[],
): { schemaMatch: SchemaMatch; missing: string[]; unknown: string[] } {
  if (!resolved) return { schemaMatch: 'dark', missing: [], unknown: [] };
  const r = compareWriteFields(resolved.keys, verb, columns);
  return { schemaMatch: r.schemaMatch, missing: r.missingRequired, unknown: r.unknownKeys };
}

function buildDrift(
  contract: GraphNode,
  table: string,
  verb: PythonWriteSite['verb'],
  resolved: ResolvedBody | null,
  missing: string[],
  unknown: string[],
  source: SourceRef,
): DriftFinding[] {
  if (!resolved) return [];
  const findings: DriftFinding[] = [];
  for (const col of missing) {
    findings.push(tagged(contract, source, 'warn',
      `Python ${verb} of \`${table}\` omits NOT-NULL column \`${col}\` (resolved ${resolved.kind} payload).`,
      'python-missing-required-column'));
  }
  for (const key of unknown) {
    findings.push(tagged(contract, source, 'warn',
      `Python ${verb} of \`${table}\` writes unknown key \`${key}\` not in the schema (resolved ${resolved.kind} payload).`,
      'python-unknown-key'));
  }
  return findings;
}

function tagged(
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
// Write-site discovery
// ---------------------------------------------------------------------------

interface WriteCall {
  node: PyNode;
  verb: PythonWriteSite['verb'];
  scope: PyNode | null;
}

function findWriteCalls(root: PyNode): WriteCall[] {
  const out: WriteCall[] = [];
  for (const node of descendants(root)) {
    if (node.type !== 'call') continue;
    const fn = node.childForFieldName('function');
    if (!fn || fn.type !== 'attribute') continue;
    const attr = fn.childForFieldName('attribute')?.text;
    if (!attr) continue;
    const verb = WRITE_VERBS[attr];
    if (!verb) continue;
    // The receiver of `.insert(` must itself be a `.table(<lit>)` / `.from_(<lit>)`
    // chain to count as a supabase-py write. We resolve later — here just gate.
    if (!receiverHasTable(fn.childForFieldName('object'))) continue;
    out.push({ node, verb, scope: enclosingFunction(node) ?? root });
  }
  return out;
}

function receiverHasTable(receiver: PyNode | null): boolean {
  if (!receiver) return false;
  for (const d of descendants(receiver)) {
    if (d.type !== 'call') continue;
    const fn = d.childForFieldName('function');
    if (!fn || fn.type !== 'attribute') continue;
    const attr = fn.childForFieldName('attribute')?.text;
    if (attr === 'table' || attr === 'from_') {
      const arg = d.childForFieldName('arguments')?.namedChildren[0];
      if (arg && stringLiteralValue(arg) !== undefined) return true;
    }
  }
  return false;
}

function resolveTableFromChain(writeCall: PyNode): string | undefined {
  // Walk the attribute receiver chain: outerCall.fn.object is a chain; find
  // any `.table('x')` / `.from_('x')` inside.
  const fn = writeCall.childForFieldName('function');
  const receiver = fn?.childForFieldName('object');
  if (!receiver) return undefined;
  for (const d of descendants(receiver)) {
    if (d.type !== 'call') continue;
    const f = d.childForFieldName('function');
    if (!f || f.type !== 'attribute') continue;
    const attr = f.childForFieldName('attribute')?.text;
    if (attr !== 'table' && attr !== 'from_') continue;
    const arg = d.childForFieldName('arguments')?.namedChildren[0];
    const lit = arg ? stringLiteralValue(arg) : undefined;
    if (lit) return lit;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Body resolution
// ---------------------------------------------------------------------------

function resolveBody(argsNode: PyNode, scope: PyNode | null): ResolvedBody | null {
  // Treat keyword arguments as the body: `.insert(id="x", status="queued")`.
  const kwargs: string[] = [];
  let positional: PyNode | null = null;

  for (const child of argsNode.namedChildren) {
    if (child.type === 'keyword_argument') {
      const k = child.childForFieldName('name')?.text;
      if (k) kwargs.push(k);
    } else {
      // First positional wins — supabase-py writes take a single payload.
      if (!positional) positional = child;
    }
  }

  if (kwargs.length > 0 && !positional) {
    return { kind: 'kwargs', keys: kwargs };
  }
  if (!positional) return null;

  return resolvePayload(positional, scope);
}

function resolvePayload(expr: PyNode, scope: PyNode | null): ResolvedBody | null {
  switch (expr.type) {
    case 'dictionary':
      return literalDictKeys(expr);
    case 'list': {
      // List of dicts: resolve only if EVERY element is a literal dict.
      const keys = new Set<string>();
      for (const el of expr.namedChildren) {
        const resolved = el.type === 'dictionary' ? literalDictKeys(el) : null;
        if (!resolved) return null;
        for (const k of resolved.keys) keys.add(k);
      }
      return { kind: 'dict', keys: [...keys] };
    }
    case 'identifier': {
      if (!scope) return null;
      const value = findAssignedValue(scope, expr.text);
      return value ? resolvePayload(value, scope) : null;
    }
    case 'call': {
      // dict(a=1, b=2) is the only call-form we accept as a payload.
      const fn = expr.childForFieldName('function');
      if (fn?.type === 'identifier' && fn.text === 'dict') {
        const args = expr.childForFieldName('arguments');
        if (!args) return null;
        const keys: string[] = [];
        for (const child of args.namedChildren) {
          if (child.type !== 'keyword_argument') return null;
          const k = child.childForFieldName('name')?.text;
          if (!k) return null;
          keys.push(k);
        }
        return { kind: 'dict', keys };
      }
      return null;
    }
    default:
      return null;
  }
}

function literalDictKeys(dictNode: PyNode): ResolvedBody | null {
  const keys: string[] = [];
  for (const pair of dictNode.namedChildren) {
    if (pair.type !== 'pair') continue;
    const key = pair.childForFieldName('key');
    // Reject `**spread` and computed keys — any non-literal makes the whole
    // payload unsafe to claim against the schema.
    if (!key) return null;
    const lit = stringLiteralValue(key);
    if (lit === undefined) return null;
    keys.push(lit);
  }
  // A dict that contains a `**something` spread shows up as a `dictionary_splat`
  // among the named children — drop the whole payload to dark in that case.
  for (const child of dictNode.namedChildren) {
    if (child.type === 'dictionary_splat') return null;
  }
  return { kind: 'dict', keys };
}

function findAssignedValue(scope: PyNode, name: string): PyNode | null {
  // First `name = <value>` in the scope (functions are small; first wins).
  // Augmented assigns (`name += ...`) don't count as definitions.
  for (const node of descendants(scope)) {
    if (node.type !== 'assignment') continue;
    const left = node.childForFieldName('left');
    if (!left || left.type !== 'identifier' || left.text !== name) continue;
    const right = node.childForFieldName('right');
    if (right) return right;
  }
  return null;
}

function enclosingFunction(node: PyNode): PyNode | null {
  let n: PyNode | null = node.parent;
  while (n) {
    if (n.type === 'function_definition' || n.type === 'module') return n;
    n = n.parent;
  }
  return null;
}

function stringLiteralValue(node: PyNode): string | undefined {
  if (node.type !== 'string') return undefined;
  // Concatenate the literal parts (strip quotes / prefixes). f-strings have
  // `string_content` children alongside `interpolation`; if any interpolation
  // is present, refuse to treat it as a fixed string literal.
  let out = '';
  for (const child of node.namedChildren) {
    if (child.type === 'interpolation') return undefined;
    if (child.type === 'string_content') out += child.text;
  }
  // Some grammars expose the whole literal as the node text — fall back.
  if (out === '') {
    const t = node.text;
    const m = /^[a-zA-Z]?(['"])([\s\S]*)\1$/.exec(t);
    if (m) return m[2];
    return undefined;
  }
  return out;
}

function sourceFrom(node: PyNode, filePath: string): SourceRef {
  const text = node.text;
  const snippet = text.length > 600 ? `${text.slice(0, 600)}…` : text;
  return {
    language: 'python',
    filePath,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    snippet,
  };
}

function* descendants(node: PyNode): Generator<PyNode> {
  const stack: PyNode[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    yield n;
    for (let i = n.childCount - 1; i >= 0; i--) {
      const c = n.child(i);
      if (c) stack.push(c);
    }
  }
}
