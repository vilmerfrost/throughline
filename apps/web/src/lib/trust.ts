import type { DriftFinding, EdgeDirection, NodeKind, SchemaMatch, Trust } from '@throughline/core';

// A node's EFFECTIVE display verdict. Deep-parsed write touches carry an additive
// `schemaMatch`; when present it OVERRIDES `trust` for every display decision
// (color, label, tooltip, contract-dot aggregation). `dark` is shared by both
// axes and renders identically. The two NEW tiers are intentionally distinct:
//   aligned  — schema-matched, Throughline-checked, NOT compiler-enforced (teal,
//              never the verified green — a weaker guarantee than `verified`).
//   mismatch — writes a field that doesn't match the schema (the most alarming).
export type Verdict = Trust | 'aligned' | 'mismatch';

// schemaMatch wins when present (it's only set on deep-parsed writes); otherwise
// trust drives the display. Reads never carry schemaMatch, so they're unaffected.
export function effectiveVerdict(node: {
  trust?: Trust;
  schemaMatch?: SchemaMatch;
}): Verdict | undefined {
  return node.schemaMatch ?? node.trust;
}

// Plain-language trust copy. `plain` is the primary phrase shown on nodes/legend
// (jargon word kept secondary); `meaning` + `risk` are the two hover-tooltip
// lines. This copy is authored verbatim — keep it accurate, do not paraphrase.
export const TRUST_COPY: Record<Trust, { plain: string; meaning: string; risk: string }> = {
  verified: {
    plain: 'type-checked',
    meaning:
      'Inferred type, no cast — the shape is carried and checked against the schema.',
    risk: 'Low risk — a schema change here is caught by the compiler.',
  },
  narrowed: {
    plain: 'partial type',
    meaning:
      'A Pick/Omit or specific-column select — only some columns are carried.',
    risk: "Fields not selected silently aren't here; code expecting them fails.",
  },
  asserted: {
    plain: 'unchecked cast',
    meaning: 'An `as X` cast — the code assumes this shape without checking it.',
    risk: "If the real data doesn't match X, nothing catches it — breaks at runtime.",
  },
  dark: {
    plain: 'no checked type',
    meaning: 'any / never / untyped — no type is carried or checked against the table.',
    risk: 'A schema change is never caught anywhere; the payload can silently mismatch the table.',
  },
};

// Short plain phrase for an edge label = direction + trust. Full meaning + risk
// live in the edge hover tooltip (TRUST_COPY).
const EDGE_LABEL: Record<EdgeDirection, Record<Verdict, string>> = {
  write: {
    verified: 'writes checked',
    narrowed: 'writes partial',
    asserted: 'writes (cast)',
    dark: 'writes blind',
    aligned: 'writes matched',
    mismatch: 'writes mismatch',
  },
  read: {
    verified: 'reads checked',
    narrowed: 'reads partial',
    asserted: 'reads on trust',
    dark: 'reads blind',
    aligned: 'reads matched',
    mismatch: 'reads mismatch',
  },
};
export function edgeLabel(direction: EdgeDirection, verdict: Verdict): string {
  return EDGE_LABEL[direction][verdict];
}

// Trust copy (labels + blurbs). Colors live as semantic tokens, never hex here.
export const TRUST_META: Record<Trust, { label: string; blurb: string }> = {
  verified: {
    label: 'verified',
    blurb: 'Inferred type, no cast — genuinely connected.',
  },
  narrowed: {
    label: 'narrowed',
    blurb: 'Pick/Omit or partial column select — fields dropped.',
  },
  asserted: {
    label: 'asserted',
    blurb: 'An `as X` cast — "trust me", NOT verified.',
  },
  dark: {
    label: 'dark',
    blurb: 'any / never / untyped JSON boundary — flow went blind.',
  },
};

// Schema-match copy (the two NEW tiers). Same shape as TRUST_COPY so the same
// node/tooltip components render either axis. Authored verbatim — the honesty
// distinction (matched now, NOT compiler-enforced) must survive intact.
export const SCHEMA_MATCH_COPY: Record<'aligned' | 'mismatch', { plain: string; meaning: string; risk: string }> = {
  aligned: {
    plain: 'schema-matched',
    meaning:
      "Payload fields match the table's columns — checked by Throughline, not compiler-enforced.",
    risk: 'If the schema changes, nothing here errors — it silently drifts. Re-check on every schema change.',
  },
  mismatch: {
    plain: 'schema mismatch',
    meaning:
      "Payload writes a field that doesn't match the schema (a missing required column or a key the table doesn't have).",
    risk: 'This write can fail or land nowhere at runtime — see the drift finding for the exact field.',
  },
};

export const SCHEMA_MATCH_META: Record<'aligned' | 'mismatch', { label: string; blurb: string }> = {
  aligned: {
    label: 'aligned',
    // Spell out the honesty distinction vs verified, which IS compiler-enforced.
    blurb: 'schema-matched · Throughline-checked · NOT compiler-enforced (vs verified = compiler-enforced)',
  },
  mismatch: {
    label: 'mismatch',
    blurb: "writes a field that doesn't match the schema",
  },
};

function isSchemaMatchTier(v: Verdict): v is 'aligned' | 'mismatch' {
  return v === 'aligned' || v === 'mismatch';
}

// One accessor per axis-merged lookup so components never branch on the tier.
export function verdictCopy(v: Verdict): { plain: string; meaning: string; risk: string } {
  return isSchemaMatchTier(v) ? SCHEMA_MATCH_COPY[v] : TRUST_COPY[v];
}
export function verdictMeta(v: Verdict): { label: string; blurb: string } {
  return isSchemaMatchTier(v) ? SCHEMA_MATCH_META[v] : TRUST_META[v];
}

export type Tone = 'contract' | Verdict;

// Contracts use the spine tone; touches use their effective verdict (default dark).
export function toneOf(kind: NodeKind | string, verdict?: Verdict): Tone {
  return kind === 'contract' ? 'contract' : (verdict ?? 'dark');
}

// CSS-var reference (a token, never raw hex) for inline styles where a Tailwind
// class can't reach: SVG strokes, selection-ring box-shadow, JS-driven dots.
const TONE_VAR: Record<Tone, string> = {
  contract: 'var(--color-contract)',
  verified: 'var(--color-verified)',
  narrowed: 'var(--color-narrowed)',
  asserted: 'var(--color-asserted)',
  dark: 'var(--color-dark)',
  aligned: 'var(--color-aligned)',
  mismatch: 'var(--color-mismatch)',
};
export function toneVar(tone: Tone): string {
  return TONE_VAR[tone];
}

// Full literal class names so Tailwind's content scanner emits them.
const TONE_BORDER: Record<Tone, string> = {
  contract: 'border-trust-contract',
  verified: 'border-trust-verified',
  narrowed: 'border-trust-narrowed',
  asserted: 'border-trust-asserted',
  dark: 'border-trust-dark',
  aligned: 'border-trust-aligned',
  mismatch: 'border-trust-mismatch',
};
const TONE_DOT: Record<Tone, string> = {
  contract: 'bg-trust-contract',
  verified: 'bg-trust-verified',
  narrowed: 'bg-trust-narrowed',
  asserted: 'bg-trust-asserted',
  dark: 'bg-trust-dark',
  aligned: 'bg-trust-aligned',
  mismatch: 'bg-trust-mismatch',
};
export function toneBorderClass(tone: Tone): string {
  return TONE_BORDER[tone];
}
export function toneDotClass(tone: Tone): string {
  return TONE_DOT[tone];
}

// Contract-list dot: color for a contract's WORST touch verdict. null = no touches
// at all → neutral gray, deliberately NOT green. Green (verified) is earned only
// when every touch is verified; aligned-best shows teal (matched, not enforced);
// any mismatch shows the alarming mismatch color. Reuses the tokens via toneVar.
export function worstTrustVar(verdict: Verdict | null): string {
  return verdict === null ? 'var(--color-untouched)' : toneVar(verdict);
}

// Drift severities reuse existing tokens: info=contract, warn=narrowed, error=asserted.
export function severityVar(severity: DriftFinding['severity']): string {
  if (severity === 'error') return 'var(--color-asserted)';
  if (severity === 'warn') return 'var(--color-narrowed)';
  return 'var(--color-contract)';
}

// Short uppercase language tag for node headers (TS / PY / RUST / SQL / JSON).
export function langTag(language?: string): string {
  if (!language) return '';
  if (language === 'typescript') return 'TS';
  if (language === 'python') return 'PY';
  return language.toUpperCase();
}
