import type { DriftFinding, EdgeDirection, NodeKind, Trust } from '@throughline/core';

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
const EDGE_LABEL: Record<EdgeDirection, Record<Trust, string>> = {
  write: {
    verified: 'writes checked',
    narrowed: 'writes partial',
    asserted: 'writes (cast)',
    dark: 'writes blind',
  },
  read: {
    verified: 'reads checked',
    narrowed: 'reads partial',
    asserted: 'reads on trust',
    dark: 'reads blind',
  },
};
export function edgeLabel(direction: EdgeDirection, trust: Trust): string {
  return EDGE_LABEL[direction][trust];
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

export type Tone = 'contract' | Trust;

// Contracts use the spine tone; touches use their trust (defaulting to dark).
export function toneOf(kind: NodeKind | string, trust?: Trust): Tone {
  return kind === 'contract' ? 'contract' : (trust ?? 'dark');
}

// CSS-var reference (a token, never raw hex) for inline styles where a Tailwind
// class can't reach: SVG strokes, selection-ring box-shadow, JS-driven dots.
const TONE_VAR: Record<Tone, string> = {
  contract: 'var(--color-contract)',
  verified: 'var(--color-verified)',
  narrowed: 'var(--color-narrowed)',
  asserted: 'var(--color-asserted)',
  dark: 'var(--color-dark)',
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
};
const TONE_DOT: Record<Tone, string> = {
  contract: 'bg-trust-contract',
  verified: 'bg-trust-verified',
  narrowed: 'bg-trust-narrowed',
  asserted: 'bg-trust-asserted',
  dark: 'bg-trust-dark',
};
export function toneBorderClass(tone: Tone): string {
  return TONE_BORDER[tone];
}
export function toneDotClass(tone: Tone): string {
  return TONE_DOT[tone];
}

// Contract-list dot: color for a contract's WORST touch trust. null = no touches
// at all → neutral gray, deliberately NOT green. Green (verified) is earned only
// when every touch is verified; reuses the trust tokens via toneVar.
export function worstTrustVar(trust: Trust | null): string {
  return trust === null ? 'var(--color-untouched)' : toneVar(trust);
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
