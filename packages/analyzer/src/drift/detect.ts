import type {
  DriftFinding,
  EdgeDirection,
  GraphEdge,
  GraphNode,
  Language,
  SourceRef,
  SourceScope,
  Trust,
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
  source?: SourceRef;
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
      source: node.source,
    });
    byContract.set(edge.target, list);
  }
  return byContract;
}

function evaluateContract(contract: GraphNode, touches: Touch[]): DriftFinding | null {
  const table = contract.label;
  const writes = touches.filter((t) => t.direction === 'write');
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
    );
  }

  // 3. ALL-DARK WRITES — every write is type-blind.
  if (writes.length > 0 && writes.every((w) => w.trust === 'dark')) {
    const scopes = scopeBreakdown(writes);
    const testOnly = isTestOnly(scopes);
    const productionImpact = hasProduction(scopes);
    return finding(
      contract,
      'info',
      testOnly
        ? `Test-only direct writes to \`${table}\` are type-blind — no production write is directly traced.`
        : `Every directly traced write to \`${table}\` is type-blind — no writer carries the schema type.`,
      writes[0]?.source,
      scopes,
      productionImpact,
      testOnly,
    );
  }

  // 4. ASYMMETRY (hedged, info).
  if (writes.length > 0 && reads.length === 0) {
    return finding(
      contract,
      'info',
      `\`${table}\` is written by ${joinLangs(writeLangs)} but has no detected reader ` +
        `(may be consumed via a SQL view or a path Throughline doesn't scan).`,
      writes[0]?.source,
    );
  }
  if (reads.length > 0 && writes.length === 0) {
    return finding(
      contract,
      'info',
      `\`${table}\` is read by ${joinLangs(readLangs)} but has no detected writer ` +
        `(may be populated via a SQL view, seed, or a path Throughline doesn't scan).`,
      reads[0]?.source,
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
  scopes?: Partial<Record<SourceScope, number>>,
  productionImpact?: boolean,
  testOnly?: boolean,
): DriftFinding | null {
  if (!source) return null;
  return {
    contractId: contract.id,
    message,
    severity,
    source,
    ...(scopes ? { scopeBreakdown: scopes } : {}),
    ...(productionImpact !== undefined ? { productionImpact } : {}),
    ...(testOnly !== undefined ? { testOnly } : {}),
  };
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
