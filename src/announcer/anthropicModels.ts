/**
 * §78 Announcer (HS-8853) — **dynamic Anthropic model discovery**.
 *
 * The Anthropic models offered in the settings dropdown used to be a hardcoded
 * list (`ANNOUNCER_MODELS` in `models.ts`). The Models API (`GET /v1/models`)
 * reliably reports the `claude-*` models the user's key can actually use, so we
 * query it — mirroring how `localProvider.ts` discovers the local endpoint's
 * installed models. (The Models API returns id/display_name/limits/capabilities
 * but **not pricing** — there is no pricing endpoint — so per-token cost stays a
 * maintained map with a family fallback; see `announcerCost` in `models.ts`.)
 *
 * Server-only: it constructs the Anthropic SDK client with the resolved key.
 * The list call is injectable so unit tests need neither the SDK nor a network.
 * Results are cached per-key for a short TTL (the catalog changes rarely, but a
 * key swap or a newly-granted model should surface within a session).
 */
import Anthropic from '@anthropic-ai/sdk';

/** A discovered Anthropic model: its id and human label (from `display_name`). */
export interface AnthropicModelInfo { id: string; label: string }

/** How long a discovery result is trusted before re-fetching. */
export const ANTHROPIC_MODELS_TTL_MS = 5 * 60_000;

/** The raw shape we read off each Models API entry — injectable so tests can
 *  return plain objects instead of SDK instances. */
export type ListAnthropicModelsRaw = (apiKey: string) => Promise<{ id: string; display_name?: string | null }[]>;

/** Default lister: page through `client.models.list()` and collect every entry. */
const defaultLister: ListAnthropicModelsRaw = async (apiKey) => {
  const client = new Anthropic({ apiKey });
  const out: { id: string; display_name?: string | null }[] = [];
  // The SDK page is async-iterable and auto-paginates.
  for await (const model of client.models.list()) {
    out.push({ id: model.id, display_name: model.display_name });
  }
  return out;
};

let lister: ListAnthropicModelsRaw = defaultLister;
let now: () => number = () => Date.now();

/** Cache keyed by api key — a key swap must not serve the prior key's catalog. */
let cache: { at: number; apiKey: string; result: AnthropicModelInfo[] } | null = null;

/**
 * Discover the `claude-*` models the given key can use, newest-looking first
 * (the Models API returns newest-first; we preserve that order). Returns [] on
 * any error (revoked key, network) so callers fall back to the static defaults.
 * Cached per-key for `ANTHROPIC_MODELS_TTL_MS`.
 */
export async function listAnthropicModels(apiKey: string): Promise<AnthropicModelInfo[]> {
  if (apiKey === '') return [];
  const t = now();
  if (cache !== null && cache.apiKey === apiKey && t - cache.at < ANTHROPIC_MODELS_TTL_MS) return cache.result;
  let result: AnthropicModelInfo[] = [];
  try {
    const raw = await lister(apiKey);
    result = raw
      .filter(m => typeof m.id === 'string' && m.id.startsWith('claude-'))
      .map(m => ({ id: m.id, label: m.display_name !== null && m.display_name !== undefined && m.display_name !== '' ? m.display_name : m.id }));
  } catch {
    result = [];
  }
  cache = { at: t, apiKey, result };
  return result;
}

/** **TEST ONLY** — inject a fake lister + clock and clear the cache. */
export function _setAnthropicModelsForTesting(opts: { lister?: ListAnthropicModelsRaw; now?: () => number }): void {
  if (opts.lister !== undefined) lister = opts.lister;
  if (opts.now !== undefined) now = opts.now;
  cache = null;
}

/** **TEST ONLY** — restore real wiring + clear the cache. */
export function _resetAnthropicModelsForTesting(): void {
  lister = defaultLister;
  now = () => Date.now();
  cache = null;
}
