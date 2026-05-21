import type { ContractColumn, GraphNode, TrustReason } from '@throughline/core';
import { callOpenRouter, type ChatMessage, type ExplainContext } from './explain.js';

const POLISH_SYSTEM_PROMPT = `You convert a structured code-review brief into a self-contained, copy-paste-ready coding task for a code agent in another codebase.

Hard rules:
- The receiving agent does NOT know about Throughline, trust dots, trust reasons, or any internal classification system. NEVER mention them or their names.
- Use ONLY the facts in the brief. Never invent files, columns, runtime behavior, dependencies, or relationships.
- Keep all file paths, line numbers, table names, column names, column types, and verbatim code snippets exactly as provided.
- Frame the task in plain coding terms a generalist code agent will understand: type safety, schema contracts, casts, validators, generated types.
- Do NOT add scratchpad, "wait", "let me check", "looking at...", or any reasoning narration. Do not wrap the output in code fences.
- Preserve any "Track A" / "Track B" structure if present in the brief — it is intentional.

Output: a clean Markdown task brief with these sections, in this order, all using ## headings:
- Goal (1-2 sentence what-and-why)
- Files to change (use @path:line refs)
- Verbatim source (preserve exactly)
- Schema contract (table + columns + types)
- What to change (or Track A / Track B if multi-track)
- Acceptance (concrete checks)
- Out of scope

Begin output with a single H1 title that states the action plainly. End with no trailing commentary.`;


// Templated, deterministic fix-prompt builder.
//
// Rules of the road:
// - No Throughline-specific jargon in the output. The receiving code agent has
//   never heard of "trust dots" or "TrustReason". We frame everything as plain
//   coding work: type safety, schema contracts, casts, validators.
// - Honesty: every fact (file, line, snippet, columns, table) comes from the
//   analyzer's verified output. The recipes never invent code.
// - For languages Throughline can only grep-scan (Python / Rust), we still
//   produce a real code improvement (Track A) AND label the architecture-level
//   path that would let a static system verify the touch end-to-end (Track B).

export type FixPromptKind = 'code-fix' | 'no-fix-needed';

export interface FixPrompt {
  kind: FixPromptKind;
  summary: string; // one-line description shown above the prompt
  prompt: string; // copy-paste-ready prompt for a code agent
}

interface Track {
  title: string;
  body: string;
}

interface Recipe {
  kind: FixPromptKind;
  title: string; // becomes the H1 of the prompt
  summary: string; // shown in the UI above the copy block
  context: string; // 2-3 sentence "what this is" for the agent
  changes: string[]; // bullets the agent must apply
  acceptance: string[]; // verifiable checks
  outOfScope: string[];
  tracks?: { trackA: Track; trackB: Track };
  notes?: string;
}

const RECIPES: Record<TrustReason, Recipe> = {
  'ts-verified': {
    kind: 'no-fix-needed',
    title: 'No change required — this query is already statically verified',
    summary: 'Already statically verified. No change required.',
    context:
      'Static analysis already confirms this database access is fully typed end-to-end (typed Supabase client, full select, no casts). There is nothing to fix here.',
    changes: ['Do nothing. Leave this call site untouched.'],
    acceptance: ['No diff is produced for this file based on this prompt.'],
    outOfScope: [
      'Refactors unrelated to this specific call.',
      'Performance changes, naming changes, formatting.',
    ],
  },

  'ts-narrowed-select': {
    kind: 'code-fix',
    title: 'Make the partial column select intentional, or expand it',
    summary:
      'Partial column select drops fields. Decide intent: keep narrow with a comment, or expand to a full typed select.',
    context:
      'This Supabase query selects a subset of columns. The TypeScript type is narrower than the underlying row, which is fine if intentional but invisible if accidental.',
    changes: [
      'If the narrow column set is intentional (only those fields are needed downstream), add a one-line comment naming the columns and why they are sufficient.',
      'If the narrow set was accidental, replace the partial select with a full select so the typed Supabase client carries every column through.',
      'Do not introduce an `as X` cast on the result.',
    ],
    acceptance: [
      'The select expression either matches the documented intent (with comment), or covers all columns the consumer reads.',
      'No new `as` cast was added on this query.',
    ],
    outOfScope: ['Schema migrations.', 'Refactors of other unrelated queries.'],
  },

  'ts-cast-concrete': {
    kind: 'code-fix',
    title: 'Remove the `as X` cast and rely on the typed Supabase client',
    summary:
      'Result is asserted with `as X`. Remove the cast and let `SupabaseClient<Database>` infer the row shape.',
    context:
      'A Supabase query result is being cast `as X`. The cast is unverified — the compiler accepts whatever shape the developer asserted. The typed client already knows the row shape from the schema; the cast is hiding that and may diverge from reality.',
    changes: [
      'Remove the `as X` cast on this query result.',
      'If the consumer needs a narrower shape than the inferred row, use `Pick<>` / `Omit<>` on the inferred type instead of asserting a fresh interface.',
      'If the cast was hiding a real type mismatch (column type, nullability, missing column), fix the underlying type — do not replace the cast with `as unknown as X` or `as any`.',
    ],
    acceptance: [
      'No `as X` cast remains on this query result.',
      'The codebase typechecks against the existing `Database` types.',
    ],
    outOfScope: ['Migrating other unrelated `as` sites.', 'Schema changes.'],
  },

  'ts-cast-any': {
    kind: 'code-fix',
    title: 'Remove the cast to `any` / `unknown` / `never` and restore typed flow',
    summary:
      'A cast to `any` / `unknown` / `never` erased the row type. Find the real cause and fix it instead of erasing the type.',
    context:
      'A Supabase query result is being cast to `any`, `unknown`, or `never`. That removes all type information from this point downstream. There is almost always an underlying mismatch (stale generated `Database` types, a missing column, wrong nullability) that the cast is papering over.',
    changes: [
      'Remove the cast.',
      'Diagnose the original type error: missing or renamed column in the generated `Database` type, wrong nullability, or out-of-date generated types.',
      'If the generated `Database` type is stale, regenerate it (do not work around it with another cast).',
    ],
    acceptance: [
      'No `any` / `unknown` / `never` cast remains on this query result.',
      'The codebase typechecks without that cast.',
    ],
    outOfScope: ['Casts in other files.'],
  },

  'ts-bypass-any': {
    kind: 'code-fix',
    title: 'Stop bypassing the typed Supabase client — pass the table name as a literal',
    summary:
      'The table name was cast `as any`, which bypasses the typed client entirely. Pass it as a string literal instead.',
    context:
      'The argument to `.from(...)` is being cast `as any`, so the Supabase client does not match it against the `Database` schema. This makes everything downstream untyped.',
    changes: [
      'Pass the table name as a plain string literal: `.from("table_name")`.',
      'If the table name is genuinely dynamic (config-driven), keep it dynamic but document the constraint in a comment, and accept that this site cannot be type-checked.',
      'Do not paper over this with a result cast.',
    ],
    acceptance: [
      'No `as any` (or equivalent) on the table-name argument here.',
      'The query result type is inferred from `Database`, not asserted.',
    ],
    outOfScope: ['Renaming the table or the schema.'],
  },

  'ts-loose-client': {
    kind: 'code-fix',
    title: 'Type the Supabase client as `SupabaseClient<Database>`',
    summary:
      'The Supabase client at this call site is loosely typed. Type it once at the construction / import site so all consumers benefit.',
    context:
      'The Supabase client used here is not generic over `Database`, so `.from(...)` does not return the typed row. Fixing the client type at its construction site (or its shared import) is the minimal, correct change.',
    changes: [
      'Find where this Supabase client is constructed or re-exported, and type it as `SupabaseClient<Database>` using the generated `Database` type.',
      'If the project does not already import the generated `Database` type, import it from the existing types module (do not regenerate as part of this change).',
      'Do not patch this single call site with a result cast.',
    ],
    acceptance: [
      'The client used here resolves to `SupabaseClient<Database>` in the editor.',
      'The codebase typechecks.',
    ],
    outOfScope: [
      'Regenerating Supabase types — call that out as a follow-up if it is needed.',
    ],
  },

  'shallow-grep-python': {
    kind: 'code-fix',
    title: 'Make this Python database write payload schema-safe',
    summary:
      'Two-track fix: schema-safe Python payloads in this file, plus a system-level path so the touch can be statically verified.',
    context:
      'This Python code writes to the database using a plain `dict` / kwargs. There is nothing in the Python codebase tying the payload shape to the SQL schema, so a renamed column or wrong type fails silently at runtime. There is a real local fix (Track A), and a separate architecture-level path that lets the touch be statically verified across the whole system (Track B).',
    changes: [
      'Track A applies inside this Python file.',
      'Track B is an architecture-level option for separate consideration.',
    ],
    acceptance: [
      'Track A: the Python writer validates payloads against a typed model that mirrors the SQL columns before the database call.',
      'Track A: a static type checker (mypy or pyright) covers this file in CI.',
      'Track B (if pursued): the same write is reachable through a typed TypeScript path that uses `SupabaseClient<Database>`.',
    ],
    outOfScope: [
      'Refactoring unrelated Python files.',
      'Schema migrations.',
    ],
    tracks: {
      trackA: {
        title: 'Track A — Schema-safe Python writes (in this file, in this language)',
        body: [
          '- Define a typed payload model that mirrors the SQL columns. Use `pydantic.BaseModel` (preferred for runtime validation) or `typing.TypedDict` if runtime validation is not wanted.',
          '- Build the payload by constructing the model, not as a free `dict`. Pass `.model_dump()` (Pydantic) into `supabase.table(...).insert(...)`.',
          '- Add a `mypy` or `pyright` configuration that covers this file, and wire it into CI so future drift is caught at type-check time.',
          '- For nullable columns, mirror nullability in the model. For non-null columns, make the field required.',
        ].join('\n'),
      },
      trackB: {
        title: 'Track B — System-level path to static verification (cross-language)',
        body: [
          '- If this write is on a hot or critical path, consider routing it through a small typed TypeScript wrapper that uses `SupabaseClient<Database>`. The Python caller invokes it via HTTP or a job queue.',
          '- Treat the wrapper as the single source of truth for the schema contract; the Python side becomes a typed client of that wrapper, not a direct database writer.',
          '- This is a larger change. Only pursue it if the system already has a TS service surface or if the cost of silent schema drift here is high.',
        ].join('\n'),
      },
    },
    notes:
      'Track A is the right default. Track B is a separate architectural decision and should not be done under this prompt unless the maintainer explicitly approves it.',
  },

  'shallow-grep-rust': {
    kind: 'code-fix',
    title: 'Make this Rust database write payload schema-safe',
    summary:
      'Two-track fix: typed Rust payloads + an optional system-level path so the touch can be statically verified.',
    context:
      'This Rust code writes to the database via a PostgREST URL with a free-form JSON body. There is nothing tying the payload shape to the SQL schema, so a renamed column or wrong type fails at the API boundary. There is a real local fix (Track A) and an architecture-level option (Track B).',
    changes: [
      'Track A applies inside this Rust crate.',
      'Track B is an architecture-level option for separate consideration.',
    ],
    acceptance: [
      'Track A: the Rust writer serializes a typed struct (with `#[derive(Serialize)]`) whose fields mirror the SQL columns and nullability.',
      'Track A: tests exercise the request body shape against the contract.',
      'Track B (if pursued): the same write is reachable through a typed TypeScript path using `SupabaseClient<Database>`.',
    ],
    outOfScope: ['Refactoring unrelated Rust files.', 'Schema migrations.'],
    tracks: {
      trackA: {
        title: 'Track A — Typed Rust payloads',
        body: [
          '- Define a `serde::Serialize` struct whose fields exactly mirror the SQL columns and their nullability (`Option<T>` for nullable).',
          '- Replace the free-form JSON body construction with that typed struct.',
          '- Add unit tests that round-trip the struct against the expected JSON shape.',
        ].join('\n'),
      },
      trackB: {
        title: 'Track B — System-level path to static verification',
        body: [
          '- If end-to-end static verification is the goal, route this write through a typed TypeScript wrapper using `SupabaseClient<Database>`, with the Rust side calling that wrapper over HTTP.',
          '- This is a larger architectural change; only pursue with explicit approval.',
        ].join('\n'),
      },
    },
  },
};

export function buildFixPrompt(node: GraphNode, context: ExplainContext): FixPrompt {
  const reason = node.trustReason;
  if (!reason) {
    return {
      kind: 'no-fix-needed',
      summary: 'No classification available — nothing to fix.',
      prompt:
        'No classification was attached to this node. It is likely a contract / schema node (no fix needed) or the analyzer did not classify it.',
    };
  }

  const recipe = RECIPES[reason];

  const lines: string[] = [];
  lines.push(`# ${recipe.title}`);
  lines.push('');

  lines.push('## Context');
  lines.push(recipe.context);
  lines.push('');

  lines.push('## Files to change');
  if (context.touches && context.touches.length > 0) {
    for (const t of context.touches) {
      if (t.source) {
        const label = `${t.source.filePath}:${t.source.startLine}${
          t.source.endLine !== t.source.startLine ? `-${t.source.endLine}` : ''
        }`;
        lines.push(`- @${label}${t.language ? ` (${t.language})` : ''}`);
      } else {
        lines.push(`- @unknown source${t.language ? ` (${t.language})` : ''}`);
      }
    }
  } else {
    if (node.source) {
      const label = `${node.source.filePath}:${node.source.startLine}${
        node.source.endLine !== node.source.startLine ? `-${node.source.endLine}` : ''
      }`;
      lines.push(`- @${label}${node.language ? ` (${node.language})` : ''}`);
    } else {
      lines.push(`- @unknown source${node.language ? ` (${node.language})` : ''}`);
    }
  }
  lines.push('');

  if (node.source) {
    lines.push('## Verbatim source (do not paraphrase)');
    lines.push('```' + (node.source.language ?? ''));
    lines.push(node.source.snippet);
    lines.push('```');
    lines.push('');
  }

  if (context.contract) {
    lines.push(`## Schema contract to respect: \`${context.contract.table}\``);
    if (context.contract.source) {
      lines.push(
        `Defined in @${context.contract.source.filePath}:${context.contract.source.startLine}-${context.contract.source.endLine}`,
      );
    }
    if (context.contract.columns?.length) {
      lines.push('Columns:');
      for (const col of context.contract.columns) lines.push(`- ${formatColumn(col)}`);
    }
    lines.push('');
  } else if (context.columns?.length) {
    lines.push('## Schema contract to respect');
    for (const col of context.columns) lines.push(`- ${formatColumn(col)}`);
    lines.push('');
  }

  if (context.drift?.length) {
    lines.push('## Known drift on this contract');
    for (const d of context.drift) lines.push(`- ${d}`);
    lines.push('');
  }

  if (recipe.tracks) {
    lines.push(`## ${recipe.tracks.trackA.title}`);
    lines.push(recipe.tracks.trackA.body);
    lines.push('');
    lines.push(`## ${recipe.tracks.trackB.title}`);
    lines.push(recipe.tracks.trackB.body);
    lines.push('');
  } else {
    lines.push('## What to change');
    for (const c of recipe.changes) lines.push(`- ${c}`);
    lines.push('');
  }

  lines.push('## Acceptance');
  for (const a of recipe.acceptance) lines.push(`- ${a}`);
  lines.push('');

  lines.push('## Out of scope');
  for (const o of recipe.outOfScope) lines.push(`- ${o}`);
  lines.push('');

  if (recipe.notes) {
    lines.push('## Notes');
    lines.push(recipe.notes);
    lines.push('');
  }

  return {
    kind: recipe.kind,
    summary: recipe.summary,
    prompt: lines.join('\n').trimEnd(),
  };
}

function formatColumn(c: ContractColumn): string {
  return `${c.name}: ${c.type}${c.nullable === false ? ' not null' : ' nullable'}`;
}

// LLM polish step. Takes the deterministic templated brief and rewrites it as
// a natural, self-contained coding task. The brief is the grounding; the model
// is instructed to never invent facts and never mention Throughline.
//
// Falls back to the raw brief on any failure so the feature stays usable
// without an API key or network.
export async function polishFixPromptWithLLM(
  brief: FixPrompt,
  apiKey: string | undefined,
): Promise<FixPrompt> {
  if (!apiKey || brief.kind === 'no-fix-needed' || !brief.prompt.trim()) {
    return brief;
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: POLISH_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Rewrite the following brief as a self-contained coding task. Preserve every file path, line range, table name, column name and type, and verbatim snippet exactly.\n\n--- BRIEF ---\n${brief.prompt}\n--- END BRIEF ---`,
    },
  ];

  try {
    const data = await callOpenRouter(messages, apiKey, false);
    const polished = data.choices?.[0]?.message?.content?.trim();
    if (!polished) return brief;
    return { ...brief, prompt: polished };
  } catch {
    return brief;
  }
}

