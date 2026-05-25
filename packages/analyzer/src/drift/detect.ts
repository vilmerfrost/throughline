import type {
  DriftFinding,
  DriftKind,
  DriftSummary,
  EdgeDirection,
  Fixability,
  GraphEdge,
  GraphNode,
  Language,
  SourceRef,
  SourceScope,
  Trust,
  WriterLifecycle,
} from '@throughline/core';

// Find STRUCTURAL divergence RISK across the contracts, grounded entirely in the
// real touches the other three analyzers produced.
//
// HARD HONESTY RULE: we have table-level + direction + trust + language per
// touch, but NO per-column write data. So findings are justified ONLY by which
// languages touch a table, in which direction, at what trust level. We never
// claim a specific column is missing/added/renamed/mistyped — that is v2.
//
// At most ONE primary finding per contract (first match wins, highest-risk
// first). Cleanly, consistently typed tables get NO finding — silence is good.

const SHALLOW: ReadonlySet<Language> = new Set<Language>(['python', 'rust']);

interface Touch {
  language: Language;
  direction: EdgeDirection;
  trust: Trust;
  sourceScope?: SourceScope;
  lifecycle?: WriterLifecycle;
  source?: SourceRef;
}

// One canonical recommended action per drift kind. These are short, grounded
// hints — never an LLM call, never invented. Kept in this single map so adding
// a new DriftKind forces us to pick the action up front.
const RECOMMENDED_ACTION: Record<DriftKind, string> = {
  'cross-language-blind-boundary':
    'Pick ONE source of truth for the payload shape (shared schema type, generated bindings, or a typed wrapper) so the schema change shows up at every boundary.',
  'multi-writer-no-shared-type':
    'Share a single schema type (or generated bindings) across the writing languages so changes are forced through every writer.',
  'all-dark-writes':
    'Tighten the writer client so the schema type is carried (e.g. `SupabaseClient<Database>` in TS, `#[derive(Serialize)]` in Rust, typed payloads in Python).',
  'asymmetry-no-reader':
    'Confirm the table is intentionally write-only or trace the reader path (raw SQL, view, unscanned service) so it is no longer hidden from Throughline.',
  'asymmetry-no-writer':
    'Confirm the table is populated outside scanned code (seed, view, external service) or wire its writer into the analyzed surface.',
  'untouched-contract':
    'Confirm the table is still in use (or drop it) — no scanned code reads or writes it.',
  'rust-missing-required-column':
    'Add the missing NOT-NULL column to the Rust payload struct (or give the column a SQL DEFAULT).',
  'rust-conditional-serialization':
    'Confirm the Rust field is always serialized before insert, or give the database column a DEFAULT if omission is valid.',
  'rust-unknown-key':
    'Rename or remove the unknown key in the Rust payload — it is not a column on this table.',
  'python-missing-required-column':
    'Add the missing NOT-NULL column to the Python payload dict (or give the column a SQL DEFAULT).',
  'python-unknown-key':
    'Rename or remove the unknown key in the Python payload — it is not a column on this table.',
};

const FIXABILITY: Record<DriftKind, Fixability> = {
  'cross-language-blind-boundary': 'requires-investigation',
  'multi-writer-no-shared-type': 'requires-investigation',
  'all-dark-writes': 'actionable',
  'asymmetry-no-reader': 'informational',
  'asymmetry-no-writer': 'informational',
  'untouched-contract': 'informational',
  'rust-missing-required-column': 'actionable',
  'rust-conditional-serialization': 'requires-investigation',
  'rust-unknown-key': 'actionable',
  'python-missing-required-column': 'actionable',
  'python-unknown-key': 'actionable',
};

// Public: classify a finding produced outside `detectDrift` (e.g. Rust Stage
// 1a + Python payload tracing) without forcing the analyzer to know the action.
// Pure lookup — never invents a category that isn't in the taxonomy.
export function fixabilityFor(kind: DriftKind): Fixability {
  return FIXABILITY[kind];
}

export function recommendedActionFor(kind: DriftKind): string {
  return RECOMMENDED_ACTION[kind];
}

export function detectDrift(
  contracts: GraphNode[],
  touches: GraphNode[],
  edges: GraphEdge[],
): DriftFinding[] {
  const byContract = groupTouches(touches, edges);

  const findings: DriftFinding[] = [];
  for (const contract of contracts) {
    const finding = evaluateContract(contract, byContract.get(contract.id) ?? []);
    if (finding) findings.push(finding);
  }

  const severityRank: Record<DriftFinding['severity'], number> = { error: 0, warn: 1, info: 2 };
  findings.sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      a.contractId.localeCompare(b.contractId),
  );

  if (process.env.THROUGHLINE_DRIFT_DEBUG) {
    const bySeverity = tally(findings, (f) => f.severity);
    console.error(
      JSON.stringify(
        { contracts: contracts.length, findings: findings.length, bySeverity },
        null,
        2,
      ),
    );
  }

  return findings;
}

// Join edges (source = touch id, target = contract id, direction) with the touch
// nodes (language, trust, source) to get, per contract, the touches on it.
function groupTouches(touches: GraphNode[], edges: GraphEdge[]): Map<string, Touch[]> {
  const touchById = new Map(touches.map((t) => [t.id, t]));
  const byContract = new Map<string, Touch[]>();

  for (const edge of edges) {
    const node = touchById.get(edge.source);
    if (!node || !node.language || !node.trust) continue;
    const list = byContract.get(edge.target) ?? [];
    list.push({
      language: node.language,
      direction: edge.direction,
      trust: node.trust,
      sourceScope: node.sourceScope,
      lifecycle: node.lifecycle,
      source: node.source,
    });
    byContract.set(edge.target, list);
  }
  return byContract;
}

function evaluateContract(contract: GraphNode, touches: Touch[]): DriftFinding | null {
  const table = contract.label;
  // Cross-language risk lives in RUNTIME (app) writers. Migration/seed/trigger
  // touches are real evidence but a different actor — they don't make an app
  // writer's blindness "fine". We filter them out for the risk classes, but
  // keep them counted in `scopeBreakdown` so the consumer can still see them.
  const allWrites = touches.filter((t) => t.direction === 'write');
  const writes = allWrites.filter((t) => (t.lifecycle ?? 'runtime') === 'runtime');
  const reads = touches.filter((t) => t.direction === 'read');
  const writeLangs = langSet(writes);
  const readLangs = langSet(reads);

  const shallowDarkWrites = writes.filter((w) => SHALLOW.has(w.language) && w.trust === 'dark');
  const shallowDarkWriteLangs = langSet(shallowDarkWrites);

  // 1. CROSS-LANGUAGE BLIND BOUNDARY — written blind by a shallow language and
  //    read by a different language.
  if (shallowDarkWriteLangs.size > 0) {
    const differingReaders = reads.filter((r) => !shallowDarkWriteLangs.has(r.language));
    if (differingReaders.length > 0) {
      const readerLangs = langSet(differingReaders);
      const tsAssumesShape = differingReaders.some(
        (r) => r.language === 'typescript' && (r.trust === 'verified' || r.trust === 'asserted'),
      );
      const writers = joinLangs(shallowDarkWriteLangs);
      const readersText = joinLangs(readerLangs);
      return finding(
        contract,
        tsAssumesShape ? 'error' : 'warn',
        `\`${table}\` is written blind by ${writers} (no shared schema type) and read by ` +
          `${readersText}. Writers and readers are aligned by hand — a schema change won't be ` +
          `caught at any of these boundaries.`,
        shallowDarkWrites[0]?.source,
        scopeBreakdown([...shallowDarkWrites, ...differingReaders]),
        'cross-language-blind-boundary',
      );
    }
  }

  // 2. MULTI-WRITER, NO SHARED TYPE — 2+ distinct writing languages.
  if (writeLangs.size >= 2) {
    return finding(
      contract,
      'warn',
      `\`${table}\` is written by ${joinLangs(writeLangs)} independently — no shared schema ` +
        `type, so each writer keeps its payload aligned with the schema by hand.`,
      writes[0]?.source,
      scopeBreakdown(writes),
      'multi-writer-no-shared-type',
    );
  }

  // 3. ALL-DARK WRITES — every runtime write is type-blind.
  if (writes.length > 0 && writes.every((w) => w.trust === 'dark')) {
    const scopes = scopeBreakdown(writes);
    const testOnly = isTestOnly(scopes);
    return finding(
      contract,
      'info',
      testOnly
        ? `Test-only direct writes to \`${table}\` are type-blind — no production write is directly traced.`
        : `Every directly traced runtime write to \`${table}\` is type-blind — no writer carries the schema type.`,
      writes[0]?.source,
      scopes,
      'all-dark-writes',
    );
  }

  // 4. ASYMMETRY (hedged, info). Lifecycle-aware: a table that only has
  //    migration/seed/trigger writers is not "written by runtime app code".
  if (allWrites.length > 0 && reads.length === 0) {
    return finding(
      contract,
      'info',
      `\`${table}\` is written by ${joinLangs(langSet(allWrites))} but has no detected reader ` +
        `(may be consumed via a SQL view or a path Throughline doesn't scan).`,
      allWrites[0]?.source,
      scopeBreakdown(allWrites),
      'asymmetry-no-reader',
    );
  }
  if (reads.length > 0 && allWrites.length === 0) {
    return finding(
      contract,
      'info',
      `\`${table}\` is read by ${joinLangs(readLangs)} but has no detected writer ` +
        `(may be populated via a SQL view, seed, or a path Throughline doesn't scan).`,
      reads[0]?.source,
      scopeBreakdown(reads),
      'asymmetry-no-writer',
    );
  }

  // 5. UNTOUCHED CONTRACT (hedged, info).
  if (touches.length === 0) {
    return finding(
      contract,
      'info',
      `\`${table}\` is defined in SQL but no detected code touches it ` +
        `(may be used via views, raw SQL, seeds, or unscanned services).`,
      contract.source,
      undefined,
      'untouched-contract',
    );
  }

  // Cleanly/consistently typed — no finding.
  return null;
}

// A finding must be grounded in a real SourceRef; if we somehow have none, we
// decline to emit rather than fabricate one.
function finding(
  contract: GraphNode,
  severity: DriftFinding['severity'],
  message: string,
  source: SourceRef | undefined,
  scopes: Partial<Record<SourceScope, number>> | undefined,
  kind: DriftKind,
): DriftFinding | null {
  if (!source) return null;
  const productionImpact = scopes ? hasProduction(scopes) : undefined;
  const testOnly = scopes ? isTestOnly(scopes) : undefined;
  return {
    contractId: contract.id,
    message,
    severity,
    source,
    kind,
    fixability: FIXABILITY[kind],
    recommendedAction: RECOMMENDED_ACTION[kind],
    ...(scopes ? { scopeBreakdown: scopes } : {}),
    ...(productionImpact !== undefined ? { productionImpact } : {}),
    ...(testOnly !== undefined ? { testOnly } : {}),
  };
}

// Pure rollup over the drift list. Counts only — never re-classifies.
export function summarizeDrift(findings: DriftFinding[]): DriftSummary {
  const summary: DriftSummary = {
    total: findings.length,
    bySeverity: {},
    byKind: {},
    byFixability: {},
    productionImpact: 0,
    testOnly: 0,
  };
  for (const f of findings) {
    summary.bySeverity[f.severity] = (summary.bySeverity[f.severity] ?? 0) + 1;
    if (f.kind) summary.byKind[f.kind] = (summary.byKind[f.kind] ?? 0) + 1;
    if (f.fixability) {
      summary.byFixability[f.fixability] = (summary.byFixability[f.fixability] ?? 0) + 1;
    }
    if (f.productionImpact) summary.productionImpact += 1;
    if (f.testOnly) summary.testOnly += 1;
  }
  return summary;
}

function langSet(touches: Touch[]): Set<Language> {
  return new Set(touches.map((t) => t.language));
}

function joinLangs(langs: Set<Language>): string {
  return [...langs].sort().join(' + ');
}

function scopeBreakdown(touches: Touch[]): Partial<Record<SourceScope, number>> {
  const out: Partial<Record<SourceScope, number>> = {};
  for (const t of touches) {
    const scope = t.sourceScope ?? 'unknown';
    out[scope] = (out[scope] ?? 0) + 1;
  }
  return out;
}

function hasProduction(scopes: Partial<Record<SourceScope, number>>): boolean {
  return (scopes.production ?? 0) > 0;
}

function isTestOnly(scopes: Partial<Record<SourceScope, number>>): boolean {
  return Object.keys(scopes).length === 1 && (scopes.test ?? 0) > 0;
}

function tally<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
