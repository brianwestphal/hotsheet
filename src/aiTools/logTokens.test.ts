// HS-9621 — codex 0.147.0 reports token usage on a `codex.sse_event` LOG record
// (measured on the wire), not as metrics. These pin the extraction + the nesting
// math against codex's actual attribute shape, including the mix of string and
// int values it sends on one record.

import { describe, expect, it } from 'vitest';

import { extractLogTokens } from './logTokens.js';
import { disjointTokensFromLog, type LogTokenSpec } from './tokenMetrics.js';

/** The exact attribute shape captured from codex-cli 0.147.0's
 *  `response.completed` log record — some counts strings, `cached` an int. */
const codexResponseCompleted = {
  'event.name': 'codex.sse_event',
  'event.kind': 'response.completed',
  input_token_count: '14769', // string, INCLUSIVE of cached
  output_token_count: '5', // string, inclusive of reasoning
  cached_token_count: 11008, // int
  cache_write_token_count: 0, // int
  reasoning_token_count: 0, // int
  tool_token_count: '14774', // = input+output; a mislabeled total, must be ignored
  model: 'gpt-5.6-sol',
};

describe('extractLogTokens (codex, HS-9621)', () => {
  it('resolves the nested counters to disjoint columns via the registered codex plugin', () => {
    const r = extractLogTokens(codexResponseCompleted);
    expect(r).not.toBeNull();
    // input is inclusive of cached → non-cached input = 14769 − 11008 = 3761
    expect(r?.input_tokens).toBe(3761);
    expect(r?.cache_read_tokens).toBe(11008);
    expect(r?.output_tokens).toBe(5); // 5 − 0 reasoning
    expect(r?.cache_creation_tokens).toBe(0);
    expect(r?.reasoning_output_tokens).toBe(0);
    expect(r?.model).toBe('gpt-5.6-sol');
    expect(r?.tool).toBe('codex');
    // The four disjoint columns must sum to the true total input+output (14774),
    // NOT double-count the cached portion (the HS-9604 ~2× trap).
    const total = (r?.input_tokens ?? 0) + (r?.output_tokens ?? 0)
      + (r?.cache_read_tokens ?? 0) + (r?.cache_creation_tokens ?? 0);
    expect(total).toBe(14774);
  });

  it('returns null for a non-token event', () => {
    expect(extractLogTokens({ 'event.name': 'codex.api_request' })).toBeNull();
    expect(extractLogTokens({ 'event.name': 'codex.sse_event', 'event.kind': 'response.created' })).toBeNull();
    expect(extractLogTokens({})).toBeNull();
  });

  it('handles a non-cached turn (cached=0) without over-subtracting', () => {
    const r = extractLogTokens({
      ...codexResponseCompleted, input_token_count: '11438', cached_token_count: '0', tool_token_count: '11438', output_token_count: '0',
    });
    expect(r?.input_tokens).toBe(11438);
    expect(r?.cache_read_tokens).toBe(0);
  });
});

describe('disjointTokensFromLog (nesting math, HS-9621)', () => {
  const spec: LogTokenSpec = {
    eventName: 'x.usage', eventKind: 'done', modelAttr: 'model',
    inputInclusive: 'in', outputInclusive: 'out', cacheRead: 'cr', cacheCreation: 'cw', reasoning: 'r',
  };

  it('subtracts nested children and clamps at 0 for a malformed record', () => {
    // cached > input (impossible in real data) must never yield a negative addend.
    const r = disjointTokensFromLog({ 'event.name': 'x.usage', 'event.kind': 'done', in: 100, out: 30, cr: 200, cw: 0, r: 50 }, spec);
    expect(r?.input_tokens).toBe(0); // max(0, 100 − 200)
    expect(r?.output_tokens).toBe(0); // max(0, 30 − 50)
    expect(r?.cache_read_tokens).toBe(200);
    expect(r?.reasoning_output_tokens).toBe(50);
  });

  it('separates reasoning from output as a breakdown, not a peer', () => {
    const r = disjointTokensFromLog({ 'event.name': 'x.usage', 'event.kind': 'done', in: 10, out: 40, cr: 0, cw: 0, r: 15 }, spec);
    expect(r?.output_tokens).toBe(25); // 40 − 15
    expect(r?.reasoning_output_tokens).toBe(15);
  });

  it('defaults the model when the attribute is absent', () => {
    const r = disjointTokensFromLog({ 'event.name': 'x.usage', 'event.kind': 'done', in: 1, out: 1, cr: 0, cw: 0, r: 0 }, spec);
    expect(r?.model).toBe('(unknown)');
  });
});
