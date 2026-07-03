// HS-9145 — branch coverage for the pure `summarizeTimeline` (docs/67 §67.10.3).
import { describe, expect, it } from 'vitest';

import { summarizeTimeline } from './promptDrilldown.js';

const ev = (eventName: string) => ({ eventName });

describe('summarizeTimeline', () => {
  it('reports no events when the timeline is empty', () => {
    expect(summarizeTimeline({ entries: [], firstTs: null, lastTs: null }))
      .toBe('No telemetry events were recorded for this prompt.');
  });

  it('singular "event" + no duration when one event and no timestamps', () => {
    expect(summarizeTimeline({ entries: [ev('user_prompt')], firstTs: null, lastTs: null }))
      .toBe('Claude emitted 1 telemetry event handling this prompt.');
  });

  it('pluralizes events and counts api_request / tool_result (bare + dotted)', () => {
    const s = summarizeTimeline({
      entries: [ev('user_prompt'), ev('api_request'), ev('claude_code.tool_result'), ev('tool_result')],
      firstTs: null,
      lastTs: null,
    });
    // 4 events; 1 api (request, singular); 2 tools (calls, plural)
    expect(s).toBe('Claude emitted 4 telemetry events handling this prompt — 1 model request, 2 tool calls.');
  });

  it('pluralizes model requests + singularizes a single tool call', () => {
    const s = summarizeTimeline({
      entries: [ev('api_request'), ev('claude_code.api_request'), ev('tool_result')],
      firstTs: null,
      lastTs: null,
    });
    expect(s).toBe('Claude emitted 3 telemetry events handling this prompt — 2 model requests, 1 tool call.');
  });

  it('includes a duration phrase when first/last ts span a positive interval', () => {
    const s = summarizeTimeline({
      entries: [ev('user_prompt'), ev('api_request')],
      firstTs: '2026-01-01T00:00:00.000Z',
      lastTs: '2026-01-01T00:00:05.000Z',
    });
    expect(s).toContain(' over ');
    expect(s).toContain('1 model request');
  });

  it('omits the duration phrase when the interval is zero / negative / non-finite', () => {
    const zero = summarizeTimeline({ entries: [ev('x')], firstTs: '2026-01-01T00:00:00Z', lastTs: '2026-01-01T00:00:00Z' });
    expect(zero).not.toContain(' over ');
    const negative = summarizeTimeline({ entries: [ev('x')], firstTs: '2026-01-01T00:00:05Z', lastTs: '2026-01-01T00:00:00Z' });
    expect(negative).not.toContain(' over ');
    const nan = summarizeTimeline({ entries: [ev('x')], firstTs: 'not-a-date', lastTs: 'also-bad' });
    expect(nan).not.toContain(' over ');
  });

  it('omits the detail tail when there are neither api nor tool events', () => {
    const s = summarizeTimeline({ entries: [ev('user_prompt'), ev('other')], firstTs: null, lastTs: null });
    expect(s).toBe('Claude emitted 2 telemetry events handling this prompt.');
  });
});
