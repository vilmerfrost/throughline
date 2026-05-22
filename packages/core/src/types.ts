// The Throughline data model.
//
// The graph is CONTRACT-CENTRIC, not call-centric: in a multi-language repo the
// languages rarely call each other directly — they meet at shared data contracts
// (DB tables, JSON/HTTP payloads). Contracts are the spine; touch/boundary nodes
// are the places in code that read/write those contracts; trust captures how
// honestly each touch is connected.

export type Language = 'sql' | 'typescript' | 'python' | 'rust' | 'json';

export interface SourceRef {
  language: Language;
  filePath: string; // relative to repo root
  startLine: number;
  endLine: number;
  snippet: string; // the real code — this is how the node proves itself
}

export type NodeKind = 'contract' | 'touch' | 'boundary';

// verified (green):  inferred type, no cast — genuinely connected
// narrowed (yellow): Pick/Omit or partial column select — fields dropped
// asserted (red):    an `as X` cast — "trust me", NOT verified
// dark (black):      any/never/untyped JSON boundary — flow went blind
export type Trust = 'verified' | 'narrowed' | 'asserted' | 'dark';

// Stage 1a (ADDITIVE): how a deep-parsed write's serialized fields line up with
// the SQL schema, computed independently of `trust`. This is NOT `trust` and is
// NEVER folded into 'verified':
//
// aligned  the resolved fields match the schema as of now — Throughline-checked
//          against the real struct/payload, NOT compiler-enforced.
// mismatch a NOT-NULL column is missing or a written key is not in the schema —
//          a real, field-level claim grounded in the resolved struct.
// dark     the written value could not be resolved (dynamic map, conditional,
//          spread, unknown builder return); we do NOT guess.
//
// Stage 1a only POPULATES this for Rust write touches; the displayed `trust`
// stays as-is (Rust touches keep displaying dark). 1b switches the display.
export type SchemaMatch = 'aligned' | 'mismatch' | 'dark';

// Machine-readable reason a touch ended up at its trust level. The analyzer
// owns this string; the explainer surfaces it instead of inventing reasons.
export type TrustReason =
  | 'ts-verified'
  | 'ts-narrowed-select'
  | 'ts-cast-concrete'
  | 'ts-cast-any'
  | 'ts-bypass-any'
  | 'ts-loose-client'
  | 'shallow-grep-python'
  | 'shallow-grep-rust';

// Plain-English description of each TrustReason. Lives next to the type so
// the explainer prompt and any docs stay consistent with the analyzer.
export const TRUST_REASON_DESCRIPTIONS: Record<TrustReason, string> = {
  'ts-verified':
    'TypeScript via ts-morph: typed SupabaseClient<Database>, full select, no cast. Genuinely connected.',
  'ts-narrowed-select':
    'TypeScript via ts-morph: typed client but a Pick/Omit or partial column select dropped fields.',
  'ts-cast-concrete':
    'TypeScript: result was cast `as X`. The developer declared a shape; the compiler did not verify it.',
  'ts-cast-any':
    'TypeScript: result was cast to `any` / `unknown` / `never`. Type information erased.',
  'ts-bypass-any':
    'TypeScript: the table name itself was cast `as any`, bypassing the typed client entirely.',
  'ts-loose-client':
    'TypeScript: the Supabase client was not `SupabaseClient<Database>`, so no schema type was carried.',
  'shallow-grep-python':
    'Python is shallow-grep only in Throughline v1. The analyzer can detect that a write happens but cannot infer types. All Python touches are dark by analyzer definition.',
  'shallow-grep-rust':
    'Rust is shallow-grep only in Throughline v1. The analyzer detects PostgREST URL paths but cannot infer types. All Rust touches are dark by analyzer definition.',
};

// Per-language analyzer depth, surfaced into the explainer so it can correctly
// answer "how do I make this green?" — the answer often depends on the
// analyzer, not on the user's code.
export type AnalyzerDepth = 'deep' | 'shallow' | 'contract';
export const ANALYZER_DEPTH: Record<Language, AnalyzerDepth> = {
  sql: 'contract',
  typescript: 'deep',
  python: 'shallow',
  rust: 'shallow',
  json: 'shallow',
};

export interface ContractColumn {
  name: string;
  type: string;
  nullable?: boolean;
  hasDefault?: boolean; // column has a DEFAULT — so it is OPTIONAL on insert even if NOT NULL
}

// How a single contract column is read by TypeScript code, with an HONEST
// confidence tier. Only `used` is a fact; every other verdict is a heuristic
// and MUST say so in its `note`. The verdicts, from most to least certain:
//
// used            explicitly named in a `.select('… col …')` — CERTAIN.
// likely_rendered select('*') read whose result is accessed inside JSX (heuristic).
// likely_used     select('*') read whose result is accessed in non-JSX code (heuristic).
// likely_dead     select('*'/explicit) reads stayed local, column never accessed (heuristic).
// unknown         select('*') read whose result escaped local scope — we can't follow it.
export type ColumnUsageVerdict =
  | 'used'
  | 'likely_used'
  | 'likely_rendered'
  | 'likely_dead'
  | 'unknown';

// WHERE a column's value travels once read — a separate axis from `verdict`
// (which is about HOW/with-what-confidence it is read). Traced via
// findReferences across files, with a conservative bias: in doubt → `unknown`.
//
// ui_shown    a read of this column resolves to a property access INSIDE JSX.
// server_only read(s) resolve but ONLY outside JSX — never reaches a render.
// never_read  no read references this column AND we traced confidently enough.
// unknown     a read exists but the value escapes into untyped/unresolvable scope.
export type ColumnReach = 'ui_shown' | 'server_only' | 'never_read' | 'unknown';

export interface ColumnUsage {
  column: string;
  verdict: ColumnUsageVerdict;
  certain: boolean; // true ONLY for 'used'
  evidence: SourceRef[]; // real select/access sites that justify the verdict
  note: string; // e.g. "accessed as `batch.spice_density` in 2 places (heuristic)"
  // B1 reach axis (additive, optional so existing consumers — incl. the offline
  // mock — keep compiling and simply ignore it). The analyzer always populates
  // it; the UI lands in B2.
  reach?: ColumnReach; // WHERE the value travels
  escapeTrail?: SourceRef[]; // for `unknown`: the reference chain up to where the trace was lost
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  language?: Language; // touch/boundary nodes
  columns?: ContractColumn[]; // contract nodes (from SQL)
  columnUsage?: ColumnUsage[]; // contract nodes only — per-column TS read verdicts
  trust?: Trust; // touch/boundary nodes
  trustReason?: TrustReason; // why the analyzer chose this trust level
  schemaMatch?: SchemaMatch; // Stage 1a (additive): deep-parsed write touches only — struct-vs-schema verdict, separate from `trust`
  source?: SourceRef; // grounds the node in real code
  notes?: string; // short "what this does" explanation
}

export type EdgeDirection = 'read' | 'write';

export interface GraphEdge {
  id: string;
  source: string; // node id
  target: string; // node id
  direction: EdgeDirection;
}

export interface DriftFinding {
  contractId: string;
  // Table-level risk, OR a field-level claim that is PROVEN — i.e. grounded in a
  // write payload whose fields were actually resolved (Stage 1a Rust). Never an
  // unproven column-level guess.
  message: string;
  severity: 'info' | 'warn' | 'error';
  source: SourceRef;
}

// RC-a (ADDITIVE): WHY an 'unresolved-origin' touch couldn't be traced to a
// construction site — so the unresolved bucket becomes actionable. Structural,
// deterministic, never guessed:
//
// parameter        the client arrives as a function/method parameter — fix =
//                  type the parameter signature (the RootCause carries a couple
//                  real signature refs as `evidence`).
// ref              reached via a ref/closure indirection (e.g. supabaseRef.current).
// imported-untyped an imported singleton that is untyped at its definition.
// other            genuinely uncategorizable — used whenever unsure (never guess).
export type UnresolvedShape = 'parameter' | 'ref' | 'imported-untyped' | 'other';

// RC-a (ADDITIVE): the client construction a dark/asserted touch traces back to.
// Resolved deterministically by following the `.from(...)` receiver's symbol to
// its declaration — NEVER guessed. When the trace fails the touch is grouped
// under the literal name 'unresolved-origin' with NO invented `source`, and a
// `shape` records why it couldn't be resolved.
export interface RootCauseOrigin {
  name: string; // the constructor/helper that built the client (e.g. createServerClient), or 'unresolved-origin'
  source?: SourceRef; // the construction site; absent ONLY for 'unresolved-origin'
  shape?: UnresolvedShape; // set ONLY when name === 'unresolved-origin'
}

// RC-a (ADDITIVE): a deterministic rollup of dark/asserted TS touches that share
// a (reason, client-origin). Pure grouping of facts already computed by the TS
// analyzer — NO inference, NO LLM. The lever: "fix THIS construction → flip N
// touches." Ranked biggest-lever-first by `affectedCount`.
export interface RootCause {
  reason: TrustReason; // why these touches are dark/asserted (e.g. 'ts-loose-client')
  origin: RootCauseOrigin; // the shared client construction the touches trace to
  affectedCount: number; // how many touches this root cause explains (== affectedTouchIds.length)
  affectedTouchIds: string[]; // the touch node ids it explains
  affectedContracts: string[]; // the contract (table) labels those touches hit
  // RC-a addendum (additive): a capped sample of real grounding refs for an
  // 'unresolved-origin' group — e.g. function signatures for the 'parameter'
  // shape, so the fix site is visible even when there is no construction site.
  evidence?: SourceRef[];
}

export interface Graph {
  repoPath: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  drift: DriftFinding[];
  // RC-a (additive, optional so existing consumers keep compiling): deterministic
  // root-cause rollup of dark/asserted TS touches, ranked biggest-lever-first.
  rootCauses?: RootCause[];
  generatedAt: string; // ISO 8601
}
