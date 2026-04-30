/**
 * HS-8047 follow-up — `dispatchPendingPrompts` must serialize cross-project
 * prompt overlays. Pre-fix, when several projects each had a pending prompt
 * (e.g. on app launch with multiple `claude` instances parked at the same
 * WARNING prompt), the dispatcher called `openTerminalPromptOverlay` once
 * per project on the same tick. That helper does
 *   `document.querySelectorAll('.terminal-prompt-overlay').forEach(el => el.remove())`
 * before mounting the new one, so each subsequent project's overlay
 * obliterated the previous one without going through `onClose`. The user
 * saw popups flash by one after another and only the last one survived,
 * yet the earlier projects' signatures had been recorded in
 * `lastDispatchedPromptSignatures` so they never re-surfaced — the user
 * had to fall back to typing into terminals manually. The fix mirrors the
 * `permission-popup` (`activePopupRequestId`) pattern: hold one overlay at
 * a time and let the next tick pick up the next pending one after the
 * active overlay closes.
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MatchResult, NumberedMatch } from '../shared/terminalPrompt/parsers.js';
import {
  _activeOverlayKeyForTesting,
  _dispatchPendingPromptsForTesting,
  _resetDispatchStateForTesting,
  type BellStateMap,
} from './bellPoll.js';

function makeNumbered(signature: string): NumberedMatch {
  return {
    parserId: 'claude-numbered',
    shape: 'numbered',
    question: 'WARNING: Loading development channels',
    questionLines: [
      '  WARNING: Loading development channels',
      '',
      '  --dangerously-load-development-channels is for local channel development',
      '  only.',
      '',
      '  Channels: server:hotsheet-channel',
    ],
    signature,
    choices: [
      { index: 0, label: 'I am using this for local development', highlighted: true },
      { index: 1, label: 'Exit', highlighted: false },
    ],
  };
}

function buildState(entries: Array<{ secret: string; terminalId: string; match: MatchResult }>): BellStateMap {
  const m: BellStateMap = new Map();
  for (const e of entries) {
    let bucket = m.get(e.secret);
    if (bucket === undefined) {
      bucket = { anyTerminalPending: true, terminalIds: [], pendingPrompts: {} };
      m.set(e.secret, bucket);
    }
    bucket.terminalIds.push(e.terminalId);
    if (bucket.pendingPrompts === undefined) bucket.pendingPrompts = {};
    bucket.pendingPrompts[e.terminalId] = e.match;
  }
  return m;
}

beforeEach(() => {
  _resetDispatchStateForTesting();
  // happy-dom doesn't ship a real fetch — stub it so the dispatcher's
  // background `apiWithSecret(...)` calls (POST /terminal/prompt-respond
  // and /terminal/prompt-dismiss) don't reject in a way that pollutes
  // the test runner's unhandled-rejection log. The `.catch(() => {})`
  // wrappers in bellPoll already swallow real failures, but the stub
  // keeps the test deterministic.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
  }));
});

afterEach(() => {
  document.querySelectorAll('.terminal-prompt-overlay').forEach(el => el.remove());
  _resetDispatchStateForTesting();
  vi.unstubAllGlobals();
});

describe('dispatchPendingPrompts serialization (HS-8047 follow-up)', () => {
  it('shows ONE overlay when multiple projects each have a pending prompt on the same tick', () => {
    const state = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: makeNumbered('sig-a') },
      { secret: 'sec-b', terminalId: 'tB', match: makeNumbered('sig-b') },
      { secret: 'sec-c', terminalId: 'tC', match: makeNumbered('sig-c') },
    ]);

    _dispatchPendingPromptsForTesting(state);

    // Exactly one overlay in the DOM — pre-fix this would have been THREE
    // mount calls in one tick with the last winning, but the in-flight
    // mounts for sec-a and sec-b were silently destroyed by the
    // querySelectorAll-remove path inside `openTerminalPromptOverlay`.
    expect(document.querySelectorAll('.terminal-prompt-overlay').length).toBe(1);

    // Deterministic ordering — `sec-a` sorts before `sec-b` / `sec-c`.
    expect(_activeOverlayKeyForTesting()).toBe('sec-a::tA');
  });

  it('does not re-mount the same overlay on a repeated dispatch with unchanged state', () => {
    const state = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: makeNumbered('sig-a') },
      { secret: 'sec-b', terminalId: 'tB', match: makeNumbered('sig-b') },
    ]);

    _dispatchPendingPromptsForTesting(state);
    expect(document.querySelectorAll('.terminal-prompt-overlay').length).toBe(1);
    const overlayBefore = document.querySelector('.terminal-prompt-overlay');

    _dispatchPendingPromptsForTesting(state);
    expect(document.querySelectorAll('.terminal-prompt-overlay').length).toBe(1);
    // Same DOM element — no remount happened on the second tick.
    expect(document.querySelector('.terminal-prompt-overlay')).toBe(overlayBefore);
  });

  it('surfaces the next pending prompt after the active overlay closes', () => {
    const state = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: makeNumbered('sig-a') },
      { secret: 'sec-b', terminalId: 'tB', match: makeNumbered('sig-b') },
    ]);

    _dispatchPendingPromptsForTesting(state);
    expect(_activeOverlayKeyForTesting()).toBe('sec-a::tA');

    // Simulate the user clicking the X / Cancel — the overlay's close path
    // calls `onClose`, which clears `activeOverlayKey` and the dispatched
    // signature for that key.
    const overlay = document.querySelector<HTMLElement>('.terminal-prompt-overlay');
    expect(overlay).not.toBeNull();
    overlay?.querySelector<HTMLButtonElement>('.terminal-prompt-overlay-close')?.click();

    // The active overlay's DOM element is gone and `activeOverlayKey` is
    // cleared — but the user-visible state for sec-b is unchanged on the
    // server, so the next dispatch tick (here: the next call) opens it.
    expect(_activeOverlayKeyForTesting()).toBeNull();

    // sec-a's pendingPrompt is still on the server (the dismissed POST
    // would have cleared it in real life, but we're simulating a tick
    // BEFORE the long-poll has refetched). Expect sec-a NOT to re-open
    // because we just dismissed it — the signature was deleted in
    // onClose so it's a fresh candidate, but the next tick should pick
    // the LOWER key. Wait, actually sig-a was deleted, so sec-a IS a
    // candidate again. We want to verify the dispatcher progresses.
    // Build a fresh state where sec-a has been cleared server-side
    // (the realistic post-dismiss state — POST /prompt-dismiss clears
    // pendingPrompt) so only sec-b remains.
    const stateAfterDismiss = buildState([
      { secret: 'sec-b', terminalId: 'tB', match: makeNumbered('sig-b') },
    ]);
    _dispatchPendingPromptsForTesting(stateAfterDismiss);
    expect(_activeOverlayKeyForTesting()).toBe('sec-b::tB');
    expect(document.querySelectorAll('.terminal-prompt-overlay').length).toBe(1);
  });

  it('tears down the active overlay when its server-side prompt clears (e.g. user responded via terminal)', () => {
    const state = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: makeNumbered('sig-a') },
      { secret: 'sec-b', terminalId: 'tB', match: makeNumbered('sig-b') },
    ]);
    _dispatchPendingPromptsForTesting(state);
    expect(_activeOverlayKeyForTesting()).toBe('sec-a::tA');
    expect(document.querySelectorAll('.terminal-prompt-overlay').length).toBe(1);

    // Server-side scrape removed sec-a's pendingPrompt (user typed into
    // sec-a's terminal directly and pressed enter, OS scraper noticed
    // the prompt was gone, cleared the entry). On the next long-poll
    // tick the dispatcher must (1) drop the now-stale active overlay
    // and (2) surface sec-b's prompt instead.
    const stateAfterUserKeystroke = buildState([
      { secret: 'sec-b', terminalId: 'tB', match: makeNumbered('sig-b') },
    ]);
    _dispatchPendingPromptsForTesting(stateAfterUserKeystroke);
    expect(_activeOverlayKeyForTesting()).toBe('sec-b::tB');
    expect(document.querySelectorAll('.terminal-prompt-overlay').length).toBe(1);
  });

  it('skips generic-shape matches (low-confidence parser fallback)', () => {
    const generic: MatchResult = {
      parserId: 'generic',
      shape: 'generic',
      question: 'unknown prompt',
      questionLines: ['unknown prompt'],
      rawText: 'unknown prompt',
      signature: 'generic:xxx',
    };
    const state = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: generic },
    ]);
    _dispatchPendingPromptsForTesting(state);
    expect(_activeOverlayKeyForTesting()).toBeNull();
    expect(document.querySelectorAll('.terminal-prompt-overlay').length).toBe(0);
  });

  it('opens a fresh overlay when the same key gets a NEW signature (program re-asked)', () => {
    const first = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: makeNumbered('sig-1') },
    ]);
    _dispatchPendingPromptsForTesting(first);
    expect(_activeOverlayKeyForTesting()).toBe('sec-a::tA');

    // User dismisses.
    document.querySelector<HTMLButtonElement>('.terminal-prompt-overlay-close')?.click();
    expect(_activeOverlayKeyForTesting()).toBeNull();

    // Server now reports a NEW prompt signature on the same terminal —
    // claude re-asked with different content. The fact that the prior
    // prompt was dismissed should NOT prevent the new one from showing.
    const second = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: makeNumbered('sig-2') },
    ]);
    _dispatchPendingPromptsForTesting(second);
    expect(_activeOverlayKeyForTesting()).toBe('sec-a::tA');
    expect(document.querySelectorAll('.terminal-prompt-overlay').length).toBe(1);
  });

  it('does nothing when no projects have pending prompts', () => {
    _dispatchPendingPromptsForTesting(new Map());
    expect(_activeOverlayKeyForTesting()).toBeNull();
    expect(document.querySelectorAll('.terminal-prompt-overlay').length).toBe(0);
  });
});
