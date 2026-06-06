/**
 * §78 Announcer (HS-8745) — turn collected work signals into a short sequence of
 * narrated "announcement" entries via the Anthropic Messages API (structured
 * output → guaranteed-valid JSON). This is the one place the feature makes an
 * external AI call; the key (resolved in `key.ts`) is the user's, and the input
 * is the already-user-authored notes/activity assembled by `collectSignals.ts`.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import { runAppleFoundationSummarize } from './appleFoundation.js';
import { DEFAULT_LOCAL_ENDPOINT, runLocalSummarize } from './localProvider.js';
import { DEFAULT_ANNOUNCER_MODEL, providerForModel } from './models.js';

/**
 * HS-8792 — extra instruction appended to the system prompt for the **local**
 * provider only. Anthropic enforces the output shape via `output_config` and
 * Apple via guided generation; a generic local model has neither, so we must
 * spell out the exact JSON contract `parseEntriesJson` expects.
 */
const LOCAL_JSON_INSTRUCTION = `\n\nOUTPUT FORMAT: respond with ONLY a single JSON object and nothing else (no prose, no code fence): {"entries":[{"title":"...","script":"...","emphasis":["..."]}]}. "emphasis" is optional. If there is nothing worth narrating, respond with {"entries":[]}.`;

/**
 * Default model when the caller passes none. HS-8764 — defaults to the
 * **cheapest** model (Haiku) rather than Opus, since this is a high-frequency,
 * lightweight summarization; the user can opt up via the global `announcerModel`
 * setting (resolved in `src/routes/announcer.ts`). See `models.ts`.
 */
export const ANNOUNCER_MODEL: string = DEFAULT_ANNOUNCER_MODEL;

const EntrySchema = z.object({
  title: z.string(),
  script: z.string(),
  // HS-8749 (§78.5 tier 1) — 0–2 key phrases, each a VERBATIM substring of
  // `script`, that the PIP renders emphasized. Optional; absent → no emphasis.
  emphasis: z.array(z.string()).optional(),
  // HS-8789 — the model's self-assessed interestingness/importance. `low` entries
  // are routine/mechanical (esp. mid-task tool noise) and are dropped before
  // persist. Optional so providers without schema enforcement (Apple guided
  // generation) that omit it keep their entries (undefined ≠ low → kept).
  importance: z.enum(['low', 'medium', 'high']).optional(),
});
const EntriesSchema = z.object({ entries: z.array(EntrySchema) });
export type GeneratedEntry = z.infer<typeof EntrySchema>;

/** HS-8789 — drop entries the model rated `low` (routine/uninteresting). Only an
 *  explicit `low` is dropped; `undefined`/`medium`/`high` are kept, so providers
 *  that don't emit importance are unaffected. Exported for testing. */
export function dropUnimportant(entries: GeneratedEntry[]): GeneratedEntry[] {
  return entries.filter(e => e.importance !== 'low');
}

/** Validate a model's JSON output (Anthropic or the Apple helper) into entries.
 *  Returns `[]` on malformed output rather than throwing — a bad batch should
 *  never break the reel. Exported for reuse + testing. */
export function parseEntriesJson(text: string): GeneratedEntry[] {
  // Tolerate a ```json … ``` fence some models wrap output in, and a bare
  // top-level `[…]` array instead of `{entries:[…]}` (the Anthropic path is
  // always clean; this hardens the on-device + future local-endpoint paths).
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  let raw: unknown;
  try { raw = JSON.parse(unfenced); } catch { return []; }
  const candidate = Array.isArray(raw) ? { entries: raw } : raw;
  const parsed = EntriesSchema.safeParse(candidate);
  return parsed.success ? parsed.data.entries : [];
}

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
          emphasis: { type: 'array', items: { type: 'string' } },
          importance: { type: 'string', enum: ['low', 'medium', 'high'] },
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
- For each entry, set an "importance" of "low", "medium", or "high" — how interesting/significant it is to a developer hearing a briefing. Completed features/fixes, decisions, and notable changes are "medium" or "high". Routine, mechanical, or merely in-progress activity — reading files, a single command, boilerplate steps, "[in progress]" tool churn — is "low". An entry you'd mark "low" should usually just be OMITTED; only keep one if it's genuinely the only thing that happened.
- Be accurate to the signals; do not invent work that isn't described. Concise and plain over engaging and breathless — the listener wants the gist fast, not a recap.
- Optionally include an "emphasis" array of 0 to 2 short key phrases per entry — the single most important noun or action in the script (e.g. "export bug", "added tests"). Each MUST be a verbatim substring of that entry's script (exact characters, same case), so it can be visually highlighted. Omit it (or use an empty array) when nothing clearly stands out; never emphasize a whole sentence.`;

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
 * array when there's nothing meaningful (or on a malformed response). Routes by
 * the model's **provider**: `anthropic` (HS-8790) calls the Messages API with
 * the caller's key; `apple` shells out to the on-device Swift helper; `local`
 * (HS-8792) POSTs to a user-run OpenAI-compatible endpoint. The two on-device
 * providers need no key and record no cost (`usage` is null). Live mode passes a
 * `compression` altitude (HS-8768) and the per-project `dismissedTopics` omit
 * list (HS-8769). For `local`, the caller resolves `localEndpoint`/`localModel`
 * from the global config.
 */
export async function summarizeWork(
  material: string,
  opts: {
    apiKey?: string | null;
    model?: string;
    compression?: Compression;
    dismissedTopics?: readonly string[];
    localEndpoint?: string;
    localModel?: string;
  },
): Promise<SummarizeResult> {
  if (material.trim() === '') return { entries: [], usage: null };
  const model = opts.model ?? ANNOUNCER_MODEL;
  const system = buildSystemPrompt(opts);
  const provider = providerForModel(model);

  if (provider === 'apple') {
    // The on-device helper enforces the {entries:[…]} shape via FoundationModels
    // *guided generation* (the Anthropic `output_config` equivalent), so we pass
    // the same system prompt and just validate the JSON it returns. On-device =
    // free, so no usage/cost is recorded.
    const out = await runAppleFoundationSummarize(system, material);
    return { entries: dropUnimportant(parseEntriesJson(out)), usage: null };
  }

  if (provider === 'local') {
    // HS-8792 — a generic local model has no output-schema enforcement, so we
    // append the explicit JSON contract to the prompt and lean on the tolerant
    // `parseEntriesJson`. On-device = free → no usage/cost.
    const out = await runLocalSummarize(system + LOCAL_JSON_INSTRUCTION, material, {
      endpoint: opts.localEndpoint?.trim() !== undefined && opts.localEndpoint.trim() !== '' ? opts.localEndpoint : DEFAULT_LOCAL_ENDPOINT,
      model: opts.localModel ?? '',
    });
    return { entries: dropUnimportant(parseEntriesJson(out)), usage: null };
  }

  if (opts.apiKey === undefined || opts.apiKey === null || opts.apiKey === '') {
    throw new Error('No Anthropic API key configured');
  }
  const client = new Anthropic({ apiKey: opts.apiKey });
  const res = await client.messages.create({
    model,
    max_tokens: 4096,
    system,
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
  return { entries: dropUnimportant(parseEntriesJson(text)), usage };
}
