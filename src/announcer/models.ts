/**
 * §78 Announcer (HS-8764) — the Anthropic models the Announcer can summarize
 * with, ordered cheapest → most capable. The **default is the cheapest model**
 * so a high-frequency, lightweight summarization task doesn't burn Opus-tier
 * spend unless the user opts up.
 *
 * Pricing per the Claude API skill (2026, per 1M input/output tokens):
 *   Haiku 4.5  $1 / $5   ← cheapest, default
 *   Sonnet 4.6 $3 / $15
 *   Opus 4.8   $5 / $25
 *
 * Model IDs are the exact alias strings (no date suffix). This module is
 * client-safe (pure string constants — no SDK import), so the wire schema
 * (`validation.ts`), the server summarizer (`summarize.ts`), and the settings
 * UI all share one source of truth. "Least expensive for the AI tool" is
 * future-proofed by keeping the list ordered cheapest-first; a future provider
 * adds its own ordered list + default.
 */
export const ANNOUNCER_MODELS = [
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — fastest & cheapest (default)' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — balanced' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8 — most capable' },
] as const;

/** Just the ids, cheapest-first — used to build the zod enum. */
export const ANNOUNCER_MODEL_IDS = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8'] as const;

export type AnnouncerModelId = typeof ANNOUNCER_MODEL_IDS[number];

/** The cheapest model — the default when the user hasn't chosen one. */
export const DEFAULT_ANNOUNCER_MODEL: AnnouncerModelId = ANNOUNCER_MODEL_IDS[0];
