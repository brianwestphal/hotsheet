// @vitest-environment happy-dom
/**
 * HS-8780 — the plain-English summary line that leads the prompt-timeline modal,
 * so a viewer understands what they're looking at before the raw event stream.
 */
import { describe, expect, it } from 'vitest';

import { summarizeTimeline } from './promptDrilldown.js';

function evt(eventName: string): { eventName: string } {
  return { eventName };
}

describe('summarizeTimeline (HS-8780)', () => {
  it('counts events, model requests, and tool calls with a duration', () => {
    const out = summarizeTimeline({
      firstTs: '2026-05-20T10:00:00Z',
      lastTs: '2026-05-20T10:01:32Z', // 1m 32s
      entries: [
        evt('claude_code.user_prompt'),
        evt('claude_code.api_request'),
        evt('claude_code.tool_decision'),
        evt('claude_code.tool_result'),
        evt('claude_code.tool_result'),
        evt('claude_code.api_request'),
      ],
    });
    expect(out).toContain('6 telemetry events');
    expect(out).toContain('over 1m 32s');
    expect(out).toContain('2 model requests');
    expect(out).toContain('2 tool calls');
  });

  it('matches both bare and claude_code.-dotted event names', () => {
    const out = summarizeTimeline({
      firstTs: null, lastTs: null,
      entries: [evt('user_prompt'), evt('api_request'), evt('tool_result')],
    });
    expect(out).toContain('1 model request'); // singular
    expect(out).toContain('1 tool call');     // singular
    expect(out).not.toContain('over');         // no duration without timestamps
  });

  it('handles an empty timeline', () => {
    expect(summarizeTimeline({ firstTs: null, lastTs: null, entries: [] }))
      .toBe('No telemetry events were recorded for this prompt.');
  });
});
