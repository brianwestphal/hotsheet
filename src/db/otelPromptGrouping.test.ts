// HS-9623 — codex stamps no `prompt.id`, so the docs/68 timeline synthesizes a
// per-turn id at read time. These pin the turn boundaries, the thread-less
// api_request correlation by time order, the determinism the drilldown depends on
// (same events → same id), and the Claude no-op.

import { describe, expect, it } from 'vitest';

import { fillSyntheticPromptIds } from './otelPromptGrouping.js';

/** A codex JSONL event record shaped like `persistLogsPayload` writes. */
function ev(name: string, ts: string, attrs: Record<string, unknown> = {}): Record<string, unknown> {
  return { event_name: name, ts, prompt_id: null, session_id: 's1', attributes_json: attrs };
}

const CONV = '11111111-2222-3333-4444-555555555555';

describe('fillSyntheticPromptIds (codex turns, HS-9623)', () => {
  it('opens a turn at each user_prompt and joins following events until the next', () => {
    const events = [
      ev('codex.user_prompt', '2026-08-12T00:00:00.000Z', { 'conversation.id': CONV, prompt: 'first' }),
      ev('codex.api_request', '2026-08-12T00:00:01.000Z'), // no conversation.id
      ev('codex.sse_event', '2026-08-12T00:00:02.000Z', { 'conversation.id': CONV, 'event.kind': 'response.completed' }),
      ev('codex.user_prompt', '2026-08-12T00:00:10.000Z', { 'conversation.id': CONV, prompt: 'second' }),
      ev('codex.api_request', '2026-08-12T00:00:11.000Z'),
    ];
    fillSyntheticPromptIds(events);

    const turn1 = `codex.turn.${CONV}.${new Date('2026-08-12T00:00:00.000Z').getTime()}`;
    const turn2 = `codex.turn.${CONV}.${new Date('2026-08-12T00:00:10.000Z').getTime()}`;
    expect(events.map(e => e.prompt_id)).toEqual([turn1, turn1, turn1, turn2, turn2]);
    expect(turn1).not.toBe(turn2);
  });

  it('correlates a thread-less api_request to the most recent open turn by time order', () => {
    // The api_request carries no conversation.id at all — its only anchor is that
    // it falls after the second user_prompt in time.
    const events = [
      ev('codex.user_prompt', '2026-08-12T00:00:00.000Z', { 'conversation.id': CONV }),
      ev('codex.user_prompt', '2026-08-12T00:00:05.000Z', { 'conversation.id': CONV }),
      ev('codex.api_request', '2026-08-12T00:00:06.000Z'),
    ];
    fillSyntheticPromptIds(events);
    expect(events[2].prompt_id).toBe(events[1].prompt_id);
    expect(events[1].prompt_id).not.toBe(events[0].prompt_id);
  });

  it('is order-independent: the id is deterministic from the turn-start (drilldown relies on this)', () => {
    const mk = (): Record<string, unknown>[] => [
      ev('codex.sse_event', '2026-08-12T00:00:02.000Z', { 'conversation.id': CONV, 'event.kind': 'response.completed' }),
      ev('codex.user_prompt', '2026-08-12T00:00:00.000Z', { 'conversation.id': CONV }),
      ev('codex.api_request', '2026-08-12T00:00:01.000Z'),
    ];
    const a = mk(); fillSyntheticPromptIds(a);
    // Same events in a different array order still resolve to the same ids.
    const shuffled = [mk()[1], mk()[2], mk()[0]]; fillSyntheticPromptIds(shuffled);
    const expected = `codex.turn.${CONV}.${new Date('2026-08-12T00:00:00.000Z').getTime()}`;
    expect(a.every(e => e.prompt_id === expected)).toBe(true);
    expect(shuffled.every(e => e.prompt_id === expected)).toBe(true);
  });

  it('leaves a stray leading api_request (before any turn) ungrouped', () => {
    const events = [
      ev('codex.api_request', '2026-08-12T00:00:00.000Z'),
      ev('codex.user_prompt', '2026-08-12T00:00:01.000Z', { 'conversation.id': CONV }),
    ];
    fillSyntheticPromptIds(events);
    expect(events[0].prompt_id).toBeNull();
    expect(events[1].prompt_id).not.toBeNull();
  });

  it('does not touch events that already carry a real prompt_id (Claude no-op)', () => {
    const claude = [
      { event_name: 'user_prompt', ts: '2026-08-12T00:00:00.000Z', prompt_id: 'real-uuid', attributes_json: {} },
      { event_name: 'api_request', ts: '2026-08-12T00:00:01.000Z', prompt_id: 'real-uuid', attributes_json: {} },
    ];
    fillSyntheticPromptIds(claude);
    expect(claude.map(e => e.prompt_id)).toEqual(['real-uuid', 'real-uuid']);
  });

  it('keeps concurrent threads separate for thread-tagged events', () => {
    const CONV2 = '99999999-8888-7777-6666-555555555555';
    const events = [
      ev('codex.user_prompt', '2026-08-12T00:00:00.000Z', { 'conversation.id': CONV }),
      ev('codex.user_prompt', '2026-08-12T00:00:01.000Z', { 'conversation.id': CONV2 }),
      ev('codex.sse_event', '2026-08-12T00:00:02.000Z', { 'conversation.id': CONV, 'event.kind': 'response.completed' }),
    ];
    fillSyntheticPromptIds(events);
    // The completed event carries CONV, so it joins CONV's turn — not the later CONV2 turn.
    expect(events[2].prompt_id).toBe(events[0].prompt_id);
    expect(events[2].prompt_id).not.toBe(events[1].prompt_id);
  });
});
