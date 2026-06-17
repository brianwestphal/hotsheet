/**
 * §78 Announcer — the models the Announcer can summarize with, across
 * **providers** (HS-8790). Each model declares its `provider`, so the wire
 * schema (`validation.ts`), the server summarizer (`summarize.ts` →
 * `providerForModel`), and the settings UI all share one source of truth.
 *
 * Providers today:
 *  - **`anthropic`** — the Claude Messages API (the user's own API key; cloud).
 *    Ordered cheapest → most capable; Haiku is the universal default.
 *  - **`apple`** — Apple Foundation Models, on-device + free + private, via a
 *    bundled Swift helper the server shells out to (`appleFoundation.ts`).
 *    Only usable on macOS 26+ with Apple Intelligence; gated at runtime by an
 *    availability probe, and made the **default when available** (HS-8790).
 *  - **`local`** — a user-run local LLM over the **OpenAI-compatible** HTTP API
 *    (Ollama / LM Studio / llama.cpp / vLLM), on-device + free + private + cross
 *    -platform (HS-8792). One pseudo-id (`LOCAL_MODEL_ID`); the actual model
 *    name + endpoint URL live in the global config (`announcerLocalModel` /
 *    `announcerLocalEndpoint`). Gated by a reachability probe (`localProvider.ts`).
 *
 * A future provider adds its own entries + an availability gate; nothing else
 * here changes.
 *
 * Anthropic pricing per the Claude API skill (2026, per 1M input/output tokens):
 *   Haiku 4.5  $1 / $5   ← cheapest, Anthropic default
 *   Sonnet 4.6 $3 / $15
 *   Opus 4.8   $5 / $25
 * Apple Foundation Models + local models run on-device → $0.
 *
 * This module is client-safe (pure string constants — no SDK import).
 */
export type AnnouncerProvider = 'anthropic' | 'apple' | 'local';

export interface AnnouncerModel {
  id: string;
  label: string;
  provider: AnnouncerProvider;
}

/** The Apple Foundation Models pseudo-model id (one on-device model). */
export const APPLE_FOUNDATION_MODEL_ID = 'apple-foundation';

/** The local-endpoint pseudo-model id (HS-8792). The concrete model name +
 *  endpoint are stored separately (`announcerLocalModel` / `announcerLocalEndpoint`)
 *  since they're user-configurable, not a fixed registry entry. */
export const LOCAL_MODEL_ID = 'local';

/**
 * The static **fallback** list (HS-8853). The Anthropic entries here are the
 * defaults used only when live model discovery is unavailable (no key, or
 * `/v1/models` unreachable) — see `anthropicModels.ts` + the
 * `/api/announcer/status` route, which prefer the models the user's key actually
 * offers. Ordered for the model dropdown: the two on-device/free options first
 * (Apple, then local — each shown only when available), then the Anthropic models
 * cheapest → most capable.
 */
export const ANNOUNCER_MODELS: AnnouncerModel[] = [
  { id: APPLE_FOUNDATION_MODEL_ID, label: 'Apple Intelligence — on-device (free, private)', provider: 'apple' },
  { id: LOCAL_MODEL_ID, label: 'Local model — Ollama / OpenAI-compatible (free, private)', provider: 'local' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — fastest & cheapest', provider: 'anthropic' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — balanced', provider: 'anthropic' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8 — most capable', provider: 'anthropic' },
];

/** All ids — used to build the zod enum (so any model can be persisted). */
export const ANNOUNCER_MODEL_IDS = [
  APPLE_FOUNDATION_MODEL_ID, LOCAL_MODEL_ID, 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8',
] as const;

export type AnnouncerModelId = typeof ANNOUNCER_MODEL_IDS[number];

/**
 * The universal default — the cheapest Anthropic model. Used when no model is
 * chosen AND Apple Foundation Models aren't available. (When Apple is available,
 * the runtime default resolver prefers it; see `resolveAnnouncerModel`.)
 */
export const DEFAULT_ANNOUNCER_MODEL: AnnouncerModelId = 'claude-haiku-4-5';

/** The provider that backs a model id. Unknown ids fall back to `anthropic`
 *  (the original behavior — they'd be Claude alias strings). */
export function providerForModel(model: string): AnnouncerProvider {
  return ANNOUNCER_MODELS.find(m => m.id === model)?.provider ?? 'anthropic';
}

/** The Anthropic model families the Announcer knows, cheapest → most capable.
 *  Used for same-family upgrade resolution (HS-8853) and family-fallback pricing. */
export type AnthropicModelFamily = 'haiku' | 'sonnet' | 'opus';

/** Parse a current-scheme Anthropic id (`claude-<family>-<major>-<minor>`, e.g.
 *  `claude-sonnet-4-6`) into its family + numeric version. Returns null for the
 *  on-device pseudo-ids and any id that doesn't match the scheme (older dated
 *  snapshots, `claude-fable-5`, etc.) — callers treat null as "can't compare". */
export function parseAnthropicModel(id: string): { family: AnthropicModelFamily; major: number; minor: number } | null {
  const m = /^claude-(haiku|sonnet|opus)-(\d+)-(\d+)$/.exec(id);
  if (m === null) return null;
  return { family: m[1] as AnthropicModelFamily, major: Number(m[2]), minor: Number(m[3]) };
}

/** Order two parsed versions (major then minor). */
function compareVersion(a: { major: number; minor: number }, b: { major: number; minor: number }): number {
  return a.major !== b.major ? a.major - b.major : a.minor - b.minor;
}

/**
 * HS-8853 — pick the best available model id for a saved selection. If the saved
 * id is still offered, keep it. Otherwise, if it parses to a known family, return
 * the **newest available model in that same family** (so a retired
 * `claude-sonnet-4-5` upgrades to `claude-sonnet-4-6`, NOT to a different family
 * like `claude-opus-4-8`). Returns null when nothing in the same family is
 * available — the caller then falls back to its own default.
 */
export function resolveBestModelForSelection(selectedId: string, availableIds: readonly string[]): string | null {
  if (availableIds.includes(selectedId)) return selectedId;
  const target = parseAnthropicModel(selectedId);
  if (target === null) return null;
  let best: { id: string; major: number; minor: number } | null = null;
  for (const id of availableIds) {
    const parsed = parseAnthropicModel(id);
    if (parsed === null || parsed.family !== target.family) continue;
    if (best === null || compareVersion(parsed, best) > 0) best = { id, ...parsed };
  }
  return best?.id ?? null;
}

/** Per-model price in US dollars per 1M input / output tokens (HS-8766).
 *  Apple/local are on-device ($0). Unknown ids fall back to same-family pricing,
 *  then the default model's pricing, in `announcerCost`. */
export interface ModelPricing { inputPerMTok: number; outputPerMTok: number }
export const ANNOUNCER_PRICING: Record<string, ModelPricing> = {
  [APPLE_FOUNDATION_MODEL_ID]: { inputPerMTok: 0, outputPerMTok: 0 },
  [LOCAL_MODEL_ID]: { inputPerMTok: 0, outputPerMTok: 0 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
};

/** Per-family fallback pricing (HS-8853). The Models API doesn't publish prices,
 *  so a newly-discovered model (e.g. a future `claude-sonnet-4-7`) isn't in
 *  `ANNOUNCER_PRICING` yet — price it at its family's published rate rather than
 *  the flat default, which would otherwise mis-price an opus model as haiku. */
export const ANNOUNCER_FAMILY_PRICING: Record<AnthropicModelFamily, ModelPricing> = {
  haiku: { inputPerMTok: 1, outputPerMTok: 5 },
  sonnet: { inputPerMTok: 3, outputPerMTok: 15 },
  opus: { inputPerMTok: 5, outputPerMTok: 25 },
};

/** Dollar cost of one summarization given the model + token counts. Exact id
 *  pricing wins; an unlisted Anthropic id falls back to its family's rate
 *  (HS-8853); a truly unknown id falls back to the default model's pricing. */
export function announcerCost(model: string, inputTokens: number, outputTokens: number): number {
  const family = parseAnthropicModel(model)?.family;
  let p: ModelPricing;
  if (model in ANNOUNCER_PRICING) {
    p = ANNOUNCER_PRICING[model];
  } else if (family !== undefined) {
    p = ANNOUNCER_FAMILY_PRICING[family];
  } else {
    p = ANNOUNCER_PRICING[DEFAULT_ANNOUNCER_MODEL];
  }
  return (inputTokens / 1_000_000) * p.inputPerMTok + (outputTokens / 1_000_000) * p.outputPerMTok;
}
