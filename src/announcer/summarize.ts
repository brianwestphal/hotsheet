/**
 * §78 Announcer (HS-8745) — turn collected work signals into a short sequence of
 * narrated "announcement" entries via the Anthropic Messages API (structured
 * output → guaranteed-valid JSON). This is the one place the feature makes an
 * external AI call; the key (resolved in `key.ts`) is the user's, and the input
 * is the already-user-authored notes/activity assembled by `collectSignals.ts`.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import { DEFAULT_ANNOUNCER_MODEL } from './models.js';

/**
 * Default model when the caller passes none. HS-8764 — defaults to the
 * **cheapest** model (Haiku) rather than Opus, since this is a high-frequency,
 * lightweight summarization; the user can opt up via the global `announcerModel`
 * setting (resolved in `src/routes/announcer.ts`). See `models.ts`.
 */
export const ANNOUNCER_MODEL: string = DEFAULT_ANNOUNCER_MODEL;

const EntrySchema = z.object({ title: z.string(), script: z.string() });
const EntriesSchema = z.object({ entries: z.array(EntrySchema) });
export type GeneratedEntry = z.infer<typeof EntrySchema>;

/** Token usage from one summarization (HS-8766) — captured even when parsing
 *  the response fails, since the API call (and its cost) already happened. */
export interface SummarizeUsage { inputTokens: number; outputTokens: number }
export interface SummarizeResult { entries: GeneratedEntry[]; usage: SummarizeUsage | null }

/** JSON Schema for `output_config.format` — a raw schema (not the SDK's zod
 *  helper) to stay independent of the zod-v4 ↔ helper compatibility surface;
 *  the response text is still validated with `EntriesSchema` below. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          script: { type: 'string' },
        },
        required: ['title', 'script'],
        additionalProperties: false,
      },
    },
  },
  required: ['entries'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are the "Announcer" for Hot Sheet, a local project-management tool. You narrate, for a developer or project manager, the work that was just done on their project — the kind of spoken "here's what happened while you were away" briefing.

You are given a chronological list of raw work signals: completion/ticket notes the AI wrote when it finished tickets, status changes, and activity-log events. Turn them into a short sequence of narrated entries to be read aloud by text-to-speech.

Rules:
- Produce 1 to 4 entries. Strongly prefer FEWER, broader entries: group related signals into one (e.g. "fixed the export bug and added tests" is one entry, not three). Two or three tight entries usually beats five.
- Each entry has a short "title" (a few words) and a "script". Keep the script to ONE or at most two short sentences — aim for under 30 words. It's spoken aloud, so be terse: lead with what changed, drop preamble ("I went ahead and…", "It looks like…"), filler, and hedging. No markdown, no code blocks, no bullet symbols, no ticket-number jargon unless it genuinely aids clarity.
- Lead with the most significant work. Skip noise (routine status pings, trivial log lines) — if nothing meaningful happened, return an empty entries array.
- Be accurate to the signals; do not invent work that isn't described. Concise and plain over engaging and breathless — the listener wants the gist fast, not a recap.`;

/** Summarization "altitude" — `high` is the catch-up compression used by live
 *  mode when the listener has fallen behind (HS-8768). */
export type Compression = 'normal' | 'high';

/** Build the system prompt, layering the live-mode directives (HS-8768 backlog
 *  compression + HS-8769 learn-from-skips) onto the base brevity rules. */
export function buildSystemPrompt(opts: { compression?: Compression; dismissedTopics?: readonly string[] } = {}): string {
  let prompt = SYSTEM_PROMPT;
  if (opts.compression === 'high') {
    prompt += `\n\nBACKLOG: the listener has fallen behind and narration must catch up. Be maximally terse — produce AT MOST 1 or 2 entries, merging everything into the highest-level summary. Favor one broad sentence ("finished the export feature and its tests") over any per-item detail.`;
  }
  const topics = opts.dismissedTopics?.filter(t => t.trim() !== '') ?? [];
  if (topics.length > 0) {
    prompt += `\n\nThe listener has marked these topics as uninteresting — OMIT anything similar and do not narrate it: ${topics.map(t => `"${t}"`).join(', ')}.`;
  }
  return prompt;
}

/**
 * Summarize the assembled `material` into narrated entries. Returns an empty
 * array when there's nothing meaningful (or on a malformed response). The caller
 * supplies the resolved API key and may override the model. Live mode passes a
 * `compression` altitude (HS-8768) and the per-project `dismissedTopics` omit
 * list (HS-8769).
 */
export async function summarizeWork(
  material: string,
  opts: { apiKey: string; model?: string; compression?: Compression; dismissedTopics?: readonly string[] },
): Promise<SummarizeResult> {
  if (material.trim() === '') return { entries: [], usage: null };
  const client = new Anthropic({ apiKey: opts.apiKey });
  const res = await client.messages.create({
    model: opts.model ?? ANNOUNCER_MODEL,
    max_tokens: 4096,
    system: buildSystemPrompt(opts),
    messages: [{ role: 'user', content: material }],
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
  });

  // HS-8766 — capture usage regardless of whether parsing succeeds; the call
  // (and its cost) already happened.
  const usage: SummarizeUsage = {
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
  };

  let text = '';
  for (const block of res.content) {
    if (block.type === 'text') text += block.text;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { entries: [], usage };
  }
  const parsed = EntriesSchema.safeParse(raw);
  return { entries: parsed.success ? parsed.data.entries : [], usage };
}
