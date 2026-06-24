// HS-8965 — shared one-shot structured-JSON AI call through the configured
// announcer provider (Anthropic / local OpenAI-compatible / Apple Foundation
// Models), extracted from the HS-8963/8976 suggest-N estimator so the partition
// helper reuses the exact same provider routing. Mirrors `src/announcer/summarize.ts`.
import Anthropic from '@anthropic-ai/sdk';

import { runAppleFoundationSummarize } from '../announcer/appleFoundation.js';
import { resolveAnnouncerModel } from '../announcer/generate.js';
import { resolveAnnouncerKey } from '../announcer/key.js';
import { DEFAULT_LOCAL_ENDPOINT, runLocalSummarize } from '../announcer/localProvider.js';
import { providerForModel } from '../announcer/models.js';
import { readGlobalConfig } from '../global-config.js';

/**
 * Run `system` + `material` through the configured announcer provider, asking for
 * a JSON object matching `schema`. Returns the raw JSON text, or **null** when no
 * provider can run (an Anthropic model but no key) so the caller falls back to a
 * deterministic heuristic. Throws on a provider error (caller catches → fallback).
 * `localJsonInstruction` is appended to the prompt for the schema-less local path.
 */
export async function callAnnouncerJson(
  system: string, material: string, schema: Record<string, unknown>, localJsonInstruction: string, maxTokens = 1024,
): Promise<string | null> {
  const model = await resolveAnnouncerModel();
  const provider = providerForModel(model);

  if (provider === 'apple') {
    return runAppleFoundationSummarize(system, material, schema);
  }
  if (provider === 'local') {
    const cfg = readGlobalConfig();
    const endpoint = cfg.announcerLocalEndpoint !== undefined && cfg.announcerLocalEndpoint.trim() !== '' ? cfg.announcerLocalEndpoint : DEFAULT_LOCAL_ENDPOINT;
    return runLocalSummarize(system + localJsonInstruction, material, { endpoint, model: cfg.announcerLocalModel ?? '' });
  }

  // Anthropic — needs the key; without it, signal "no provider" → heuristic.
  const apiKey = await resolveAnnouncerKey();
  if (apiKey === null) return null;
  const res = await new Anthropic({ apiKey }).messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: material }],
    output_config: { format: { type: 'json_schema', schema } },
  });
  let text = '';
  for (const block of res.content) if (block.type === 'text') text += block.text;
  return text;
}
