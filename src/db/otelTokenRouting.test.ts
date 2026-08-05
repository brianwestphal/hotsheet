/**
 * HS-9604 — routing token counters to rollup columns across tools.
 *
 * The tests that matter here are the NEGATIVE ones. Getting Claude's four
 * disjoint buckets right is easy; the failure this ticket exists to prevent is
 * routing codex's inclusive parent alongside its children and reporting ~2x the
 * real total in a way that looks entirely plausible.
 */
import { describe, expect, it } from 'vitest';

import {
  isTokenRollupMetric,
  tokenColumnForDatapoint,
  tokenColumnFromTypeAttribute,
} from './otelTokenRouting.js';

const CLAUDE_TOKENS = 'claude_code.token.usage';
const CX = 'codex.turn.token_usage.';

describe('Claude — one metric split by its `type` attribute', () => {
  it('routes each of the four disjoint buckets', () => {
    expect(tokenColumnForDatapoint(CLAUDE_TOKENS, { type: 'input' })).toBe('input_tokens');
    expect(tokenColumnForDatapoint(CLAUDE_TOKENS, { type: 'output' })).toBe('output_tokens');
    expect(tokenColumnForDatapoint(CLAUDE_TOKENS, { type: 'cacheRead' })).toBe('cache_read_tokens');
    expect(tokenColumnForDatapoint(CLAUDE_TOKENS, { type: 'cacheCreation' })).toBe('cache_creation_tokens');
  });

  it('accepts the snake_case attribute spellings too', () => {
    expect(tokenColumnFromTypeAttribute({ type: 'cache_read' })).toBe('cache_read_tokens');
    expect(tokenColumnFromTypeAttribute({ type: 'cache_creation' })).toBe('cache_creation_tokens');
  });

  it('counts an unknown type as a datapoint with no tokens, not as unrecognized', () => {
    // The metric IS a rollup metric — the row still records that a datapoint
    // arrived — but it contributes to no column. Conflating this with "ignore"
    // would silently drop a counter Claude may add later.
    expect(isTokenRollupMetric(CLAUDE_TOKENS)).toBe(true);
    expect(tokenColumnForDatapoint(CLAUDE_TOKENS, { type: 'somethingNew' })).toBeNull();
    expect(tokenColumnForDatapoint(CLAUDE_TOKENS, {})).toBeNull();
  });
});

describe('codex — separate metrics, NESTED (the double-count guard)', () => {
  it('routes the three counters that are genuinely disjoint', () => {
    // `input = cached + non_cached`, so the non-cached half is what corresponds
    // to Claude's `input` bucket.
    expect(tokenColumnForDatapoint(`${CX}non_cached_input_tokens`, {})).toBe('input_tokens');
    expect(tokenColumnForDatapoint(`${CX}cached_input_tokens`, {})).toBe('cache_read_tokens');
    expect(tokenColumnForDatapoint(`${CX}cache_write_input_tokens`, {})).toBe('cache_creation_tokens');
    expect(tokenColumnForDatapoint(`${CX}output_tokens`, {})).toBe('output_tokens');
  });

  it('does NOT route the inclusive `input_tokens` parent — this is the 2x bug', () => {
    // Measured 4778/4778: `cached_input_tokens` is INSIDE `input_tokens`.
    // Routing both would count cached input twice. On the largest real sample
    // (190,406,252 input of which 186,577,664 cached) a summed total reads
    // ~377M against a true ~190M.
    expect(isTokenRollupMetric(`${CX}input_tokens`)).toBe(false);
    expect(tokenColumnForDatapoint(`${CX}input_tokens`, {})).toBeNull();
  });

  it('does NOT route `reasoning_output_tokens` — it is inside `output_tokens`', () => {
    // 4778/4778. Folding it into output would double-count; storing it
    // faithfully needs a breakdown column, tracked separately. Neither is
    // "route it anyway".
    expect(isTokenRollupMetric(`${CX}reasoning_output_tokens`)).toBe(false);
  });

  it('does NOT route either total — both are derivable and would triple-count', () => {
    expect(isTokenRollupMetric(`${CX}total_tokens`)).toBe(false);
    expect(isTokenRollupMetric('codex.usage.total_tokens')).toBe(false);
  });

  it('sums to the truth over a realistic datapoint set', () => {
    // The end-to-end property, stated as arithmetic rather than as four
    // separate routings: feed every counter codex emits for one turn and the
    // routed columns must total exactly `total_tokens`, not more.
    const turn: Record<string, number> = {
      [`${CX}input_tokens`]: 47468,           // inclusive parent
      [`${CX}cached_input_tokens`]: 18176,
      [`${CX}non_cached_input_tokens`]: 29292, // 47468 - 18176
      [`${CX}cache_write_input_tokens`]: 0,
      [`${CX}output_tokens`]: 340,
      [`${CX}reasoning_output_tokens`]: 60,    // inside output
      [`${CX}total_tokens`]: 47808,
    };
    let summed = 0;
    for (const [name, value] of Object.entries(turn)) {
      if (tokenColumnForDatapoint(name, {}) !== null) summed += value;
    }
    expect(summed).toBe(47808);
  });
});

describe('the OTel GenAI conventions — inherited by any tool that follows them', () => {
  it('routes the vendor-neutral counters without a per-tool entry', () => {
    // Attributed via the `gen_ai.` namespace, which no plugin claims — so this
    // also pins that an unattributed-but-standard counter still aggregates.
    expect(tokenColumnForDatapoint('gen_ai.usage.input_tokens', {})).toBe('input_tokens');
    expect(tokenColumnForDatapoint('gen_ai.usage.output_tokens', {})).toBe('output_tokens');
    expect(tokenColumnForDatapoint('gen_ai.usage.cache_read.input_tokens', {})).toBe('cache_read_tokens');
    expect(tokenColumnForDatapoint('gen_ai.usage.cache_write.input_tokens', {})).toBe('cache_creation_tokens');
  });
});

describe('unrecognized metrics', () => {
  it('are not rollup metrics and route nowhere', () => {
    expect(isTokenRollupMetric('gemini_cli.tokens')).toBe(false);
    expect(isTokenRollupMetric('claude_code.user_prompt')).toBe(false);
    expect(tokenColumnForDatapoint('something.entirely.else', { type: 'input' })).toBeNull();
  });

  it('do not inherit a `type` attribute from a tool that uses one', () => {
    // A stray metric carrying `type: 'input'` must not be swept into Claude's
    // bucket just because the attribute happens to be present.
    expect(tokenColumnForDatapoint('vendor.token.usage', { type: 'input' })).toBeNull();
  });
});
