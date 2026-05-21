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

export interface ColumnUsage {
  column: string;
  verdict: ColumnUsageVerdict;
  certain: boolean; // true ONLY for 'used'
  evidence: SourceRef[]; // real select/access sites that justify the verdict
  note: string; // e.g. "accessed as `batch.spice_density` in 2 places (heuristic)"
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
  message: string; // table-level risk, never an unproven column-level claim
  severity: 'info' | 'warn' | 'error';
  source: SourceRef;
}

export interface Graph {
  repoPath: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  drift: DriftFinding[];
  generatedAt: string; // ISO 8601
}
