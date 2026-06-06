/**
 * §78 Announcer (HS-8792) — the **local-endpoint** summarization provider.
 *
 * A cross-platform, on-device, free + private alternative to Anthropic (cloud)
 * and Apple Foundation Models (macOS-only): the user runs a local LLM server
 * that speaks the **OpenAI-compatible** HTTP API — Ollama, LM Studio,
 * llama.cpp's server, vLLM, etc. all do — and the Hot Sheet server POSTs to it.
 * One integration covers every runtime, with no native compile or code-signing.
 *
 * Config (global): `announcerLocalEndpoint` is the OpenAI-compatible base URL
 * (default `http://localhost:11434/v1`, Ollama's port); `announcerLocalModel` is
 * the concrete model name. Availability is a reachability probe of `{base}/models`
 * (HS-8792): reachable AND ≥1 model present → usable. The same probe surfaces the
 * installed-model list for the settings dropdown. Because the *server* runs it,
 * this works in both the manual "Listen" path and the live-mode generator.
 *
 * Everything here is pure Node (global `fetch`) and unit-tested with an injected
 * fetch + clock; nothing macOS-specific.
 */
import { readGlobalConfig } from '../global-config.js';

/** Default OpenAI-compatible base URL — Ollama's port + `/v1` prefix. */
export const DEFAULT_LOCAL_ENDPOINT = 'http://localhost:11434/v1';

/** How long a probe result is trusted before re-checking. Unlike the Apple
 *  helper (OS-model state rarely changes in a session), a local server can be
 *  started/stopped mid-session, so this is a short TTL rather than forever. */
export const LOCAL_PROBE_TTL_MS = 10_000;

/** The subset of `fetch` this module uses — injectable so the probe + summarize
 *  paths are testable without a real server. */
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

let doFetch: FetchLike = defaultFetch;
let now: () => number = () => Date.now();

interface ProbeResult { available: boolean; models: string[] }
let cache: { at: number; result: ProbeResult } | null = null;

/** The configured OpenAI-compatible base URL (no trailing slash), falling back
 *  to the Ollama default when unset/blank. */
export function resolveLocalEndpoint(): string {
  const configured = readGlobalConfig().announcerLocalEndpoint?.trim();
  const base = configured !== undefined && configured !== '' ? configured : DEFAULT_LOCAL_ENDPOINT;
  return base.replace(/\/+$/, '');
}

/** The configured local model name (or '' when unset). */
export function resolveLocalModel(): string {
  return readGlobalConfig().announcerLocalModel?.trim() ?? '';
}

/** Probe `{base}/models` once, caching for `LOCAL_PROBE_TTL_MS`. Reachable + at
 *  least one model listed ⇒ available; the model ids feed the settings dropdown. */
async function probe(): Promise<ProbeResult> {
  const t = now();
  if (cache !== null && t - cache.at < LOCAL_PROBE_TTL_MS) return cache.result;
  let result: ProbeResult = { available: false, models: [] };
  try {
    const res = await doFetch(`${resolveLocalEndpoint()}/models`);
    if (res.ok) {
      const raw: unknown = await res.json();
      const models = parseModelList(raw);
      result = { available: models.length > 0, models };
    }
  } catch {
    result = { available: false, models: [] };
  }
  cache = { at: t, result };
  return result;
}

/** Extract model ids from an OpenAI `/models` response (`{ data: [{ id }] }`).
 *  Tolerant of shape drift — returns [] rather than throwing. */
function parseModelList(raw: unknown): string[] {
  if (raw === null || typeof raw !== 'object') return [];
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const item of data) {
    if (item !== null && typeof item === 'object') {
      const id = (item as { id?: unknown }).id;
      if (typeof id === 'string' && id !== '') ids.push(id);
    }
  }
  return ids;
}

/** Whether a local OpenAI-compatible endpoint is reachable with ≥1 model. */
export async function isLocalProviderAvailable(): Promise<boolean> {
  return (await probe()).available;
}

/** The installed-model ids reported by the local endpoint (for the settings
 *  dropdown). Empty when unreachable. */
export async function listLocalModels(): Promise<string[]> {
  return (await probe()).models;
}

/**
 * Run one summarization against the local OpenAI-compatible chat endpoint.
 * Returns the model's raw message content (expected `{entries:[…]}` JSON — the
 * caller validates it with the shared schema via `parseEntriesJson`). On-device,
 * so no usage/cost. Throws when no model is configured or the call fails.
 */
export async function runLocalSummarize(
  system: string,
  material: string,
  opts: { endpoint: string; model: string },
): Promise<string> {
  if (opts.model.trim() === '') throw new Error('No local model configured');
  const base = opts.endpoint.replace(/\/+$/, '');
  const res = await doFetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: material },
      ],
      // Ask for a JSON object where supported (OpenAI + Ollama honor this); the
      // caller's `parseEntriesJson` also tolerates a fenced / bare-array reply,
      // so an endpoint that ignores `response_format` still works.
      response_format: { type: 'json_object' },
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`Local model endpoint returned HTTP ${String(res.status)}`);
  const raw: unknown = await res.json();
  return extractChatContent(raw);
}

/** Pull `choices[0].message.content` from an OpenAI chat-completion response. */
function extractChatContent(raw: unknown): string {
  if (raw === null || typeof raw !== 'object') return '';
  const choices = (raw as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first: unknown = choices[0]; // `Array.isArray` narrows to `any[]`; pin back to unknown.
  if (first === null || typeof first !== 'object') return '';
  const message = (first as { message?: unknown }).message;
  if (message === null || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : '';
}

/** **TEST ONLY** — inject a fake fetch + clock and clear the probe cache. */
export function _setLocalProviderForTesting(opts: { fetch?: FetchLike; now?: () => number }): void {
  if (opts.fetch !== undefined) doFetch = opts.fetch;
  if (opts.now !== undefined) now = opts.now;
  cache = null;
}

/** **TEST ONLY** — restore real wiring + clear the cache. */
export function _resetLocalProviderForTesting(): void {
  doFetch = defaultFetch;
  now = () => Date.now();
  cache = null;
}
