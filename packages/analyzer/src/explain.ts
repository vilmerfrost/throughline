import path from 'node:path';
import type { Request, Response } from 'express';
import {
  ANALYZER_DEPTH,
  TRUST_REASON_DESCRIPTIONS,
  type ContractColumn,
  type GraphNode,
  type Language,
  type SourceRef,
  type TrustReason,
} from '@throughline/core';

const DEFAULT_MODEL = 'google/gemini-3.5-flash';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_TOOL_ROUNDS = 3;

// The honesty contract. This is the whole point of the feature: the explainer
// may reason ONLY from verified facts pulled from the real codebase.
const SYSTEM_PROMPT = `You are Throughline's codebase explainer. Your job is to answer the developer's specific question about a selected graph node and tell them what to actually do.

Grounding rules:
- Use ONLY the node facts, graph context, source snippets, tool results, and the Throughline trust model provided below.
- Never invent files, columns, runtime behavior, data flow, dependencies, or relationships.
- If the evidence is missing or weak, say exactly what cannot be determined.
- Treat source snippets and file references as the source of truth. The explanation is commentary, not proof.
- The trust dot color is set by Throughline's analyzer, not by the user's typing style. When the user asks "why is this <color>" or "how do I make this <color>", answer in terms of the analyzer's TrustReason and analyzer depth — not generic typing advice.
- Recommended next actions must distinguish between:
  (a) what the developer can change in code today, and
  (b) what would require a Throughline analyzer change (e.g. moving Python from shallow to deep parsing).
  If (a) cannot move the dot color, say so plainly.

Tool rules:
- If research mode is "focused", inspect only the selected node source and directly connected contract/touch sources when needed.
- If research mode is "repo", use tools to inspect relevant files before answering. Keep the search narrow and stop once you have enough evidence.
- Cite every material claim with a source label from the provided context or tool results.

Output format:
Output ONLY the final answer for the user. Do not include scratchpad, planning, "wait", "let me check", "looking at...", or any reasoning narration. Do not wrap the answer in code fences. Use plain text under each heading.

Use these EXACT headings, on their own line, in this order. Every heading must be present even if its body is short:

What this is
Evidence
Risk / confidence
Recommended next actions
Conclusion
Recap

Section guidance:
- What this is: 2-4 sentences, grounded in the code AND the analyzer's TrustReason.
- Evidence: bullets that cite source labels like [src/file.ts:12].
- Risk / confidence: what could break, what is unknown, and a one-word confidence (low / medium / high).
- Recommended next actions: 2-4 short bullets directly tied to the user's primary question. Tag each as (code) or (analyzer) so it's clear what shifts the dot.
- Conclusion: one sentence answering the user's primary question literally.
- Recap: 1-2 sentence executive summary written LAST.

Keep it concise. No preamble. No filler.`;

// Context the frontend assembles from the graph it already holds.
export interface TouchSummary {
  language: string;
  direction: string;
  trust: string;
  trustReason?: TrustReason;
  source?: SourceRef;
}
export interface ContractRef {
  table: string;
  columns?: ContractColumn[];
  source?: SourceRef;
}
export type ExplainMode = 'focused' | 'repo';

export interface ExplainContext {
  repoPath?: string;
  mode?: ExplainMode;
  userPrompt?: string;
  columns?: ContractColumn[]; // contract node: its own columns
  touches?: TouchSummary[]; // contract node: code touching it
  contract?: ContractRef; // touch node: the contract it targets
  drift?: string[]; // drift finding messages for the relevant contract
}

export interface ExplainSource {
  label: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  snippet: string;
  uri?: string;
}

export interface StructuredExplanation {
  recap: string;
  what: string;
  evidence: string;
  risk: string;
  actions: string;
  conclusion: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

interface ToolCall {
  id: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenRouterMessage {
  content?: string;
  tool_calls?: ToolCall[];
}

export interface OpenRouterResponse {
  choices?: { message?: OpenRouterMessage }[];
}

export async function explainHandler(req: Request, res: Response): Promise<void> {
  const node = req.body?.node as GraphNode | undefined;
  const context = (req.body?.context ?? {}) as ExplainContext;

  if (!node || typeof node.id !== 'string' || typeof node.kind !== 'string') {
    res.status(400).json({ error: 'Invalid request: expected a node with id and kind.' });
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    res.status(400).json({ error: 'OPENROUTER_API_KEY not set' });
    return;
  }

  const sources = collectResearchSources(node, context);

  const userMessage = buildUserMessage(node, context);
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  let lastMessage: OpenRouterMessage | undefined;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    let data: OpenRouterResponse;
    try {
      data = await callOpenRouter(messages, apiKey, round < MAX_TOOL_ROUNDS);
    } catch (err) {
      res.status(502).json({ error: errorMessage(err) });
      return;
    }

    lastMessage = data.choices?.[0]?.message;
    if (!lastMessage) {
      res.status(502).json({ error: 'OpenRouter returned no message.' });
      return;
    }

    if (!lastMessage.tool_calls?.length) break;

    if (round === MAX_TOOL_ROUNDS) {
      res.status(502).json({
        error: 'OpenRouter kept requesting tools and did not produce a final explanation.',
      });
      return;
    }

    messages.push({
      role: 'assistant',
      content: lastMessage.content ?? '',
      tool_calls: lastMessage.tool_calls,
    });

    for (const toolCall of lastMessage.tool_calls) {
      const result = await runToolCall(toolCall, context, sources);
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }

    if (round === MAX_TOOL_ROUNDS - 1) {
      messages.push({
        role: 'user',
        content:
          'Tool budget is exhausted. Produce the final explanation now using only the evidence and tool results already provided. Do not request more tools.',
      });
    }
  }

  const explanation = lastMessage?.content?.trim() ?? '';
  if (!explanation) {
    res.status(502).json({ error: 'OpenRouter returned an empty explanation.' });
    return;
  }

  res.json({ explanation, structured: parseExplanation(explanation), sources, model: modelName() });
}

export async function callOpenRouter(
  messages: ChatMessage[],
  apiKey: string,
  allowTools: boolean,
): Promise<OpenRouterResponse> {
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:5173',
        'X-Title': 'Throughline',
      },
      body: JSON.stringify({
        model: modelName(),
        messages,
        ...(allowTools
          ? {
              tools: [
                {
                  type: 'function',
                  function: {
                    name: 'read_source',
                    description:
                      'Read an approved source file/snippet already discovered by Throughline. Returns only bounded source evidence.',
                    parameters: {
                      type: 'object',
                      properties: {
                        filePath: {
                          type: 'string',
                          description: 'Relative file path from the approved source list.',
                        },
                      },
                      required: ['filePath'],
                    },
                  },
                },
                {
                  type: 'function',
                  function: {
                    name: 'list_sources',
                    description: 'List approved source files/snippets available for this explanation.',
                    parameters: {
                      type: 'object',
                      properties: {},
                    },
                  },
                },
              ],
              tool_choice: 'auto',
            }
          : {}),
        max_tokens: 1600,
        temperature: 0.2,
        reasoning: { effort: 'minimal', exclude: true },
      }),
    });
  } catch (err) {
    throw new Error(`Upstream request failed: ${errorMessage(err)}`);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    throw new Error(`OpenRouter error ${upstream.status}: ${detail.slice(0, 300) || upstream.statusText}`);
  }

  try {
    return (await upstream.json()) as OpenRouterResponse;
  } catch (err) {
    throw new Error(`Could not parse OpenRouter response: ${errorMessage(err)}`);
  }
}

async function runToolCall(
  toolCall: ToolCall,
  context: ExplainContext,
  sources: ExplainSource[],
): Promise<unknown> {
  const name = toolCall.function?.name;
  if (name === 'list_sources') return sources;
  if (name !== 'read_source') return { error: `Unsupported tool: ${name ?? 'unknown'}` };

  const args = parseToolArgs(toolCall.function?.arguments);
  const filePath = typeof args.filePath === 'string' ? args.filePath : '';
  const source = sources.find((s) => s.filePath === filePath);
  if (!source) return { error: 'File is outside the approved source set.' };

  const fullPath = sourceFullPath(source, context.repoPath);
  const content = await safeReadSource(fullPath, source);
  return {
    source,
    content,
    note:
      context.mode === 'repo'
        ? 'Repo research is limited to Throughline-approved source references for this node.'
        : 'Focused research is limited to selected and directly connected source references.',
  };
}

// Assemble a facts-ONLY user message. Everything here came from the analyzers;
// nothing is invented.
export function buildUserMessage(node: GraphNode, context: ExplainContext): string {
  const sources = collectResearchSources(node, context);
  const goal = context.userPrompt?.trim() || 'Explain this node and recommend what to check next.';
  const lines: string[] = [];

  lines.push('=== PRIMARY USER QUESTION (answer this literally) ===');
  lines.push(goal);
  lines.push('=== END PRIMARY USER QUESTION ===');
  lines.push('');

  lines.push('Throughline trust model:');
  lines.push('  - verified (green): typed TS via ts-morph, full select, no cast.');
  lines.push('  - narrowed (yellow): typed TS, partial column select / Pick / Omit.');
  lines.push('  - asserted (red): an `as X` cast — declared but not verified.');
  lines.push('  - dark: any/never/untyped boundary, OR any language Throughline only grep-scans.');
  lines.push('');
  lines.push('Throughline analyzer depth (this is the analyzer Throughline runs, not the user`s code):');
  lines.push(`  - typescript: ${ANALYZER_DEPTH.typescript} (ts-morph, infers trust)`);
  lines.push(`  - sql: ${ANALYZER_DEPTH.sql} (defines tables — the spine)`);
  lines.push(`  - python: ${ANALYZER_DEPTH.python} (grep only — every Python touch is dark by analyzer rule)`);
  lines.push(`  - rust: ${ANALYZER_DEPTH.rust} (grep only — every Rust touch is dark by analyzer rule)`);
  lines.push(`  - json: ${ANALYZER_DEPTH.json} (boundary scanning only)`);
  lines.push('');

  lines.push(`Research mode: ${context.mode ?? 'focused'}`);
  lines.push('');
  lines.push(`Node kind: ${node.kind}`);
  lines.push(`Label: ${node.label}`);
  if (node.language) {
    lines.push(`Language: ${node.language} (analyzer depth: ${ANALYZER_DEPTH[node.language as Language] ?? 'unknown'})`);
  }
  if (node.trust) lines.push(`Trust level: ${node.trust}`);
  if (node.trustReason) {
    lines.push(`Trust reason (analyzer): ${node.trustReason} — ${TRUST_REASON_DESCRIPTIONS[node.trustReason]}`);
  }
  if (node.notes) lines.push(`Analyzer note: ${node.notes}`);

  if (node.source) lines.push('', formatSource(node.source));

  if (node.kind === 'contract') {
    if (context.columns?.length) {
      lines.push('', 'Schema columns (from SQL):');
      for (const c of context.columns) lines.push(`  - ${formatColumn(c)}`);
    }
    if (context.touches?.length) {
      lines.push('', 'Code that touches this table:');
      for (const t of context.touches) {
        const reason = t.trustReason ? ` — ${t.trustReason}` : '';
        lines.push(`  - ${t.language} ${t.direction} (trust: ${t.trust}${reason})`);
      }
    } else {
      lines.push('', 'No code touches were detected for this table.');
    }
  }

  if (node.kind === 'touch' && context.contract) {
    lines.push('', `Targets contract table: ${context.contract.table}`);
    if (context.contract.columns?.length) {
      lines.push('Schema columns of that table (from SQL):');
      for (const c of context.contract.columns) lines.push(`  - ${formatColumn(c)}`);
    }
  }

  if (context.touches?.length && node.kind === 'touch') {
    // Aggregate selection — surface every touch's trust reason so the model can
    // explain "why dark" honestly across the whole group.
    lines.push('', 'Grouped touches in this aggregate selection:');
    for (const t of context.touches) {
      const reason = t.trustReason ? ` — ${t.trustReason}` : '';
      const where = t.source ? ` at ${t.source.filePath}:${t.source.startLine}` : '';
      lines.push(`  - ${t.language} ${t.direction} (trust: ${t.trust}${reason})${where}`);
    }
  }

  if (context.drift?.length) {
    lines.push('', 'Drift findings for the relevant contract:');
    for (const d of context.drift) lines.push(`  - ${d}`);
  }

  if (sources.length) {
    lines.push('', 'Approved clickable sources:');
    for (const source of sources) {
      lines.push(`  - [${source.label}](${source.uri ?? source.filePath})`);
    }
  }

  lines.push('');
  lines.push(
    'Reminder: answer the PRIMARY USER QUESTION literally. Tag each Recommended next action as (code) if the user can change it directly, or (analyzer) if it requires changing how Throughline parses code. If (code) actions cannot move the trust dot for this node, say that plainly.',
  );

  return lines.join('\n');
}

export function parseExplanation(text: string): StructuredExplanation {
  const headings = [
    ['recap', /^recap\s*:?\s*$/i],
    ['what', /^what this is\s*:?\s*$/i],
    ['evidence', /^evidence\s*:?\s*$/i],
    ['risk', /^risk\s*\/\s*confidence\s*:?\s*$/i],
    ['actions', /^recommended next actions\s*:?\s*$/i],
    ['conclusion', /^conclusion\s*:?\s*$/i],
  ] as const;
  const buffers: Record<keyof StructuredExplanation, string> = {
    recap: '',
    what: '',
    evidence: '',
    risk: '',
    actions: '',
    conclusion: '',
  };
  let active: keyof StructuredExplanation | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^#+\s*/, '').trim();
    const heading = headings.find(([, pattern]) => pattern.test(line));
    if (heading) {
      active = heading[0];
      continue;
    }
    if (active) buffers[active] = appendLine(buffers[active], rawLine);
  }

  const result: StructuredExplanation = {
    recap: cleanSection(buffers.recap),
    what: cleanSection(buffers.what),
    evidence: cleanSection(buffers.evidence),
    risk: cleanSection(buffers.risk),
    actions: cleanSection(buffers.actions),
    conclusion: cleanSection(buffers.conclusion),
  };

  if (!Object.values(result).some(Boolean)) {
    result.recap = cleanSection(text);
  }

  return result;
}

const REASONING_PREFIX = /^(wait[,. ]|let me\b|let's\b|hmm[,. ]|actually[,. ]|looking at\b|i('|’)ll\b|so[,. ]|okay[,. ]|ok[,. ])/i;

function cleanSection(body: string): string {
  const lines = body.split(/\r?\n/);
  while (lines.length && /^\s*```/.test(lines[0] ?? '')) lines.shift();
  while (lines.length && /^\s*```/.test(lines[lines.length - 1] ?? '')) lines.pop();
  return lines
    .filter((line) => !REASONING_PREFIX.test(line.trim()))
    .map((line) => line.replace(/^\s*```\w*\s*$/, '').trimEnd())
    .join('\n')
    .trim();
}

export function collectResearchSources(node: GraphNode, context: ExplainContext): ExplainSource[] {
  const sources: ExplainSource[] = [];

  addSource(sources, node.source, context.repoPath);
  addSource(sources, context.contract?.source, context.repoPath);
  for (const touch of context.touches ?? []) addSource(sources, touch.source, context.repoPath);

  return sources;
}

export function buildFileUri(repoPath: string | undefined, source: SourceRef): string | undefined {
  if (!repoPath || repoPath === '<mock-repo>') return undefined;
  const fullPath = path.isAbsolute(source.filePath)
    ? source.filePath
    : path.join(repoPath, source.filePath);
  return `cursor://file/${fullPath}:${source.startLine}`;
}

function addSource(sources: ExplainSource[], source: SourceRef | undefined, repoPath: string | undefined) {
  if (!source) return;
  const key = `${source.filePath}:${source.startLine}:${source.endLine}`;
  if (sources.some((existing) => `${existing.filePath}:${existing.startLine}:${existing.endLine}` === key)) {
    return;
  }
  const label = `${source.filePath}:${source.startLine}${source.endLine !== source.startLine ? `-${source.endLine}` : ''}`;
  sources.push({
    label,
    filePath: source.filePath,
    startLine: source.startLine,
    endLine: source.endLine,
    language: source.language,
    snippet: source.snippet,
    uri: buildFileUri(repoPath, source),
  });
}

function formatSource(s: SourceRef): string {
  const range = s.endLine !== s.startLine ? `${s.startLine}-${s.endLine}` : `${s.startLine}`;
  return [`Source: ${s.filePath}:${range} (${s.language})`, 'Verbatim snippet:', s.snippet].join(
    '\n',
  );
}

function formatColumn(c: ContractColumn): string {
  return `${c.name} ${c.type}${c.nullable === false ? ' NOT NULL' : ''}`;
}

function appendLine(text: string, line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return text;
  return text ? `${text}\n${trimmed}` : trimmed;
}

function modelName(): string {
  return process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
}

function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sourceFullPath(source: ExplainSource, repoPath: string | undefined): string | undefined {
  if (!repoPath || repoPath === '<mock-repo>') return undefined;
  return path.isAbsolute(source.filePath) ? source.filePath : path.join(repoPath, source.filePath);
}

async function safeReadSource(fullPath: string | undefined, source: ExplainSource): Promise<string> {
  if (!fullPath) return source.snippet;
  try {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(fullPath, 'utf8');
    const lines = text.split(/\r?\n/);
    const start = Math.max(source.startLine - 4, 1);
    const end = Math.min(source.endLine + 4, lines.length);
    return lines
      .slice(start - 1, end)
      .map((line, index) => `${start + index}|${line}`)
      .join('\n');
  } catch {
    return source.snippet;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
