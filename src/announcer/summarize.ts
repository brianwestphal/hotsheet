/**
 * §78 Announcer (HS-8745) — turn collected work signals into a short sequence of
 * narrated "announcement" entries via the Anthropic Messages API (structured
 * output → guaranteed-valid JSON). This is the one place the feature makes an
 * external AI call; the key (resolved in `key.ts`) is the user's, and the input
 * is the already-user-authored notes/activity assembled by `collectSignals.ts`.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

/**
 * Default model. Per the Anthropic API skill, the default is `claude-opus-4-8`
 * unless the user names another. Exposed as a constant (and overridable per
 * call) so a cost-conscious user can switch to e.g. `claude-haiku-4-5` for this
 * high-frequency, lightweight summarization without touching call sites.
 */
export const ANNOUNCER_MODEL = 'claude-opus-4-8';

const EntrySchema = z.object({ title: z.string(), script: z.string() });
const EntriesSchema = z.object({ entries: z.array(EntrySchema) });
export type GeneratedEntry = z.infer<typeof EntrySchema>;

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
- Produce 1 to 5 entries. Group related signals into one coherent entry rather than one entry per signal (e.g. "fixed the export bug and added tests" is one entry, not three).
- Each entry has a short "title" (a few words, what it's about) and a "script" (1-3 sentences of natural spoken English to be read aloud — no markdown, no code blocks, no bullet symbols, no ticket-number jargon unless it aids clarity; spell out what changed and why it matters).
- Lead with the most significant work. Skip noise (routine status pings, trivial log lines) — if nothing meaningful happened, return an empty entries array.
- Be accurate to the signals; do not invent work that isn't described. Be concise and engaging, not breathless.`;

/**
 * Summarize the assembled `material` into narrated entries. Returns an empty
 * array when there's nothing meaningful (or on a malformed response). The caller
 * supplies the resolved API key and may override the model.
 */
export async function summarizeWork(
  material: string,
  opts: { apiKey: string; model?: string },
): Promise<GeneratedEntry[]> {
  if (material.trim() === '') return [];
  const client = new Anthropic({ apiKey: opts.apiKey });
  const res = await client.messages.create({
    model: opts.model ?? ANNOUNCER_MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: material }],
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
  });

  let text = '';
  for (const block of res.content) {
    if (block.type === 'text') text += block.text;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const parsed = EntriesSchema.safeParse(raw);
  return parsed.success ? parsed.data.entries : [];
}
