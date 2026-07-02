/**
 * HS-9278 — direct unit tests for `getPromptTimelineFromJsonl`, the pure per-store
 * scan the §68 prompt-timeline drilldown now uses instead of SQL over the raw
 * `otel_events` / `otel_spans` tables. Seeds JSONL day files in a temp cluster dir
 * and reads them back — no DB / project-registration needed.
 */
import { rmSync } from 'fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDir } from '../test-helpers.js';
import { getPromptTimelineFromJsonl } from './otelDashboard.js';
import { _resetOtelJsonlForTesting, appendOtelJsonl } from './otelJsonlStore.js';

let dir: string;
beforeEach(() => { dir = createTempDir(); _resetOtelJsonlForTesting(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function ev(ts: string, promptId: string, eventName: string, attrs: Record<string, unknown> = {}): Promise<void> {
  const d = new Date(ts);
  await appendOtelJsonl(dir, 'events', d, {
    ts: d.toISOString(), project_secret: 'sec', session_id: 's', prompt_id: promptId,
    event_name: eventName, attributes_json: attrs, body_json: {},
  });
}
async function span(startTs: string, promptId: string, spanId: string, parentSpanId: string | null, name: string): Promise<void> {
  const d = new Date(startTs);
  await appendOtelJsonl(dir, 'spans', d, {
    trace_id: 't', span_id: spanId, parent_span_id: parentSpanId, project_secret: 'sec', session_id: 's',
    prompt_id: promptId, span_name: name, start_ts: d.toISOString(), end_ts: new Date(d.getTime() + 100).toISOString(),
    attributes_json: {}, status_code: 'OK',
  });
}

describe('getPromptTimelineFromJsonl (HS-9278)', () => {
  it('returns the prompt’s events sorted by ts, model from user_prompt, and excludes other prompts', async () => {
    await ev('2026-05-20T10:00:05Z', 'p1', 'claude_code.api_request');
    await ev('2026-05-20T10:00:00Z', 'p1', 'claude_code.user_prompt', { model: 'sonnet-4' });
    await ev('2026-05-20T10:00:10Z', 'p1', 'claude_code.tool_result');
    await ev('2026-05-20T10:00:01Z', 'p2', 'claude_code.user_prompt'); // different prompt — excluded

    const tl = await getPromptTimelineFromJsonl(dir, 'p1');
    expect(tl.promptId).toBe('p1');
    expect(tl.projectSecret).toBe('sec');
    expect(tl.entries.map(e => e.eventName)).toEqual(['claude_code.user_prompt', 'claude_code.api_request', 'claude_code.tool_result']);
    expect(tl.model).toBe('sonnet-4');
    expect(tl.firstTs).toBe('2026-05-20T10:00:00.000Z');
    expect(tl.lastTs).toBe('2026-05-20T10:00:10.000Z');
    // Synthetic ids are the sorted index.
    expect(tl.entries.map(e => e.id)).toEqual([0, 1, 2]);
  });

  it('sorts spans by start_ts and returns them alongside events', async () => {
    await ev('2026-05-21T10:00:00Z', 'p-spans', 'claude_code.user_prompt', { model: 'x' });
    await span('2026-05-21T10:00:00.200Z', 'p-spans', 's2', 's1', 'llm_request');
    await span('2026-05-21T10:00:00.000Z', 'p-spans', 's1', null, 'turn');
    await span('2026-05-21T10:00:00.000Z', 'p-other', 'other', null, 'turn'); // excluded

    const tl = await getPromptTimelineFromJsonl(dir, 'p-spans');
    expect(tl.spans.map(s => s.spanId)).toEqual(['s1', 's2']);
    expect(tl.spans[0].parentSpanId).toBeNull();
    expect(tl.spans[1].parentSpanId).toBe('s1');
  });

  it('returns orphan spans (spans but no events) with an empty entries array', async () => {
    await span('2026-05-22T10:00:00Z', 'p-orphan', 's1', null, 'turn');
    const tl = await getPromptTimelineFromJsonl(dir, 'p-orphan');
    expect(tl.entries).toHaveLength(0);
    expect(tl.spans).toHaveLength(1);
    expect(tl.firstTs).toBeNull();
    expect(tl.model).toBeNull();
  });

  it('returns the empty shape for an unknown prompt', async () => {
    await ev('2026-05-23T10:00:00Z', 'p1', 'claude_code.user_prompt');
    const tl = await getPromptTimelineFromJsonl(dir, 'nope');
    expect(tl.entries).toEqual([]);
    expect(tl.spans).toEqual([]);
    expect(tl.projectSecret).toBeNull();
  });

  it('keeps insertion order for equal timestamps (stable sort ~ old ts ASC, id ASC)', async () => {
    // Three events at the SAME ts — must stay in append order.
    await ev('2026-05-24T10:00:00Z', 'p-eq', 'claude_code.user_prompt');
    await ev('2026-05-24T10:00:00Z', 'p-eq', 'claude_code.api_request');
    await ev('2026-05-24T10:00:00Z', 'p-eq', 'claude_code.tool_result');
    const tl = await getPromptTimelineFromJsonl(dir, 'p-eq');
    expect(tl.entries.map(e => e.eventName)).toEqual(['claude_code.user_prompt', 'claude_code.api_request', 'claude_code.tool_result']);
  });

  it('spans the events across multiple day files', async () => {
    await ev('2026-05-25T23:59:00Z', 'p-multi', 'claude_code.user_prompt');
    await ev('2026-05-27T00:01:00Z', 'p-multi', 'claude_code.tool_result');
    const tl = await getPromptTimelineFromJsonl(dir, 'p-multi');
    expect(tl.entries).toHaveLength(2);
    expect(tl.entries[0].eventName).toBe('claude_code.user_prompt');
  });
});
