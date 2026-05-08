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
  _dismissedTerminalPromptKeysForTesting,
  _dispatchPendingPromptsForTesting,
  _markRecentlyAnsweredForTesting,
  _minimizedTerminalPromptsForTesting,
  _recentlyAnsweredPromptsForTesting,
  _resetDispatchStateForTesting,
  type BellStateMap,
  hasAiTerminalPromptForSecret,
  reopenMinimizedTerminalPromptForSecret,
} from './bellPoll.js';
// HS-8245 — mock `dismissPermissionPopupForSecret` from permissionOverlay
// so the dispatcher's new "AI-parser candidate dismisses §47 first"
// behaviour can be observed without mounting a real channel popup.
// `hasAiTerminalPromptForSecret` is exported by bellPoll itself (the
// mock here is solely for the §47-dismiss side-effect). `vi.mock` is
// hoisted by vitest so it runs before the static imports above;
// positioning here keeps `import/first` happy.
//
// HS-8294 — extended with `dismissChannelPermissionForSecret` for the
// onSend → dismiss-on-AI-parser-answer wiring. Using a SYNCHRONOUS
// factory (no `vi.importActual` + spread) — the spread+override
// pattern silently dropped the new export under vitest's module-export
// detection so the dynamic import in `openCrossProjectOverlay::onSend`
// resolved to the real function instead of the mock.
const { dismissPermissionPopupMock, dismissChannelPermissionMock } = vi.hoisted(() => ({
  dismissPermissionPopupMock: vi.fn<(secret: string) => void>(),
  dismissChannelPermissionMock: vi.fn<(secret: string) => void>(),
}));
vi.mock('./permissionOverlay.js', () => ({
  dismissPermissionPopupForSecret: (secret: string) => dismissPermissionPopupMock(secret),
  dismissChannelPermissionForSecret: (secret: string) => dismissChannelPermissionMock(secret),
}));

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
  // HS-8245 — reset the dismiss-§47 mock between cases so spy state
  // from one test doesn't leak into the next.
  dismissPermissionPopupMock.mockReset();
  // HS-8294 — same for the new dismissChannelPermissionForSecret mock
  // (covered by the onSend → dismiss-on-AI-answer path).
  dismissChannelPermissionMock.mockReset();
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
    overlay?.querySelector<HTMLButtonElement>('.dialog-shell-close')?.click();

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
    document.querySelector<HTMLButtonElement>('.dialog-shell-close')?.click();
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

/**
 * HS-8057 — clicking "Always choose this" on a cross-project overlay
 * has to persist the rule into the ORIGINATING project's settings.json,
 * not the active project's. The dispatcher's `onAddAllowRule` callback
 * forwards the per-prompt `secret` so `appendAllowRule(rule, secret)`
 * routes through `apiWithSecret(secret)` rather than the global `api()`
 * helper. This test pins the wiring at the dispatcher boundary.
 */
describe('Always choose this — cross-project secret routing (HS-8057)', () => {
  it('forwards the originating-project secret to appendAllowRule when the user clicks a choice with the checkbox ticked', async () => {
    const appendSpy = vi.fn();
    // Lazy mock — replace the live `appendAllowRule` on the imported
    // store module. The dispatcher imports it eagerly so we have to
    // reach into the module record. Vitest's `vi.doMock` would work
    // for a re-import, but the simpler approach is to spy on the
    // network primitive (`apiWithSecret`) and assert the URL+secret
    // pair, which is what `appendAllowRule(rule, secret)` actually
    // produces. happy-dom's stubbed fetch returns `{ok:true,json:{}}`
    // (see beforeEach above) so the GET-then-PATCH sequence inside
    // appendAllowRule completes without error.
    const fetchMock = (globalThis as { fetch: typeof fetch }).fetch as unknown as ReturnType<typeof vi.fn>;

    const state = buildState([
      { secret: 'origin-secret', terminalId: 'tA', match: makeNumbered('sig-origin') },
    ]);
    _dispatchPendingPromptsForTesting(state);
    expect(_activeOverlayKeyForTesting()).toBe('origin-secret::tA');

    const overlay = document.querySelector<HTMLElement>('.terminal-prompt-overlay');
    expect(overlay).not.toBeNull();
    const checkbox = overlay!.querySelector<HTMLInputElement>('.terminal-prompt-overlay-allow-rule');
    expect(checkbox).not.toBeNull();
    // Tick the box THEN click choice 0 — the order the human takes.
    checkbox!.checked = true;
    const choice0 = overlay!.querySelector<HTMLButtonElement>('.terminal-prompt-overlay-choice[data-choice-index="0"]');
    expect(choice0).not.toBeNull();
    choice0!.click();

    // Yield the microtask queue so the appendAllowRule's awaited GET
    // resolves (stubbed fetch resolves synchronously into a promise).
    await new Promise(resolve => setTimeout(resolve, 0));

    // Find the GET-then-PATCH calls to /file-settings carrying the
    // originating project's secret in `X-Hotsheet-Secret`.
    const fileSettingsCalls = fetchMock.mock.calls.filter(call => {
      const url = String(call[0]);
      return url.includes('/api/file-settings');
    });
    expect(fileSettingsCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of fileSettingsCalls) {
      const opts = call[1] as { headers?: Record<string, string> } | undefined;
      const secretHeader = opts?.headers?.['X-Hotsheet-Secret'];
      expect(secretHeader).toBe('origin-secret');
    }
    // The POST /terminal/prompt-respond also carries the originating
    // secret — sanity-check that the rest of the dispatcher contract
    // is intact alongside the new HS-8057 rule write.
    const respondCalls = fetchMock.mock.calls.filter(call => String(call[0]).includes('/terminal/prompt-respond'));
    expect(respondCalls.length).toBe(1);

    // Silence unused-var on the spy (kept for diagnostic if a future
    // implementation switches back to a direct module spy).
    void appendSpy;
  });
});

/**
 * HS-8067 — `Minimize` and `No response needed` footer links must
 * route through bellPoll's dispatcher state so a minimized prompt
 * doesn't re-fire the overlay on every long-poll tick (the
 * server-side pending entry stays alive, so the bell-state still
 * reports it). The dispatcher's gates: `lastDispatchedPromptSignatures`
 * (bypass-on-same-sig), `minimizedTerminalPrompts` (don't re-fire,
 * 2-min auto-dismiss), `dismissedTerminalPromptKeys` (permanent skip
 * for "No response needed").
 */
describe('Minimize / No-response-needed dispatcher state (HS-8067)', () => {
  it('Minimize moves the prompt to minimizedTerminalPrompts and does NOT re-fire the overlay on the next tick', () => {
    const state = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: makeNumbered('sig-a') },
    ]);
    _dispatchPendingPromptsForTesting(state);
    expect(_activeOverlayKeyForTesting()).toBe('sec-a::tA');

    const overlay = document.querySelector<HTMLElement>('.terminal-prompt-overlay');
    expect(overlay).not.toBeNull();
    const link = overlay!.querySelector<HTMLAnchorElement>('.dialog-shell-minimize-link');
    expect(link).not.toBeNull();
    link!.click();

    // Overlay torn down, active-overlay gate cleared, but
    // minimized-prompt bookkeeping kept.
    expect(document.querySelector('.terminal-prompt-overlay')).toBeNull();
    expect(_activeOverlayKeyForTesting()).toBeNull();
    expect(_minimizedTerminalPromptsForTesting().size).toBe(1);
    expect(_minimizedTerminalPromptsForTesting().get('sec-a::tA')).toEqual({ secret: 'sec-a', terminalId: 'tA' });

    // Re-dispatch with the same state — the server-side pending entry
    // is still alive (we didn't post /terminal/prompt-dismiss). The
    // dispatcher must SKIP this prompt because it's minimized.
    _dispatchPendingPromptsForTesting(state);
    expect(document.querySelector('.terminal-prompt-overlay')).toBeNull();
    expect(_activeOverlayKeyForTesting()).toBeNull();
  });

  it('reopenMinimizedTerminalPromptForSecret restores a minimized overlay', () => {
    const state = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: makeNumbered('sig-a') },
    ]);
    _dispatchPendingPromptsForTesting(state);
    document.querySelector<HTMLAnchorElement>('.dialog-shell-minimize-link')!.click();
    expect(document.querySelector('.terminal-prompt-overlay')).toBeNull();
    expect(_minimizedTerminalPromptsForTesting().size).toBe(1);

    const restored = reopenMinimizedTerminalPromptForSecret('sec-a');
    expect(restored).toBe(true);
    expect(document.querySelector('.terminal-prompt-overlay')).not.toBeNull();
    expect(_activeOverlayKeyForTesting()).toBe('sec-a::tA');
    // Minimized bookkeeping cleared after restore.
    expect(_minimizedTerminalPromptsForTesting().size).toBe(0);
  });

  it('reopenMinimizedTerminalPromptForSecret returns false when no minimized prompt for the project', () => {
    expect(reopenMinimizedTerminalPromptForSecret('sec-nonexistent')).toBe(false);
  });

  it('"No response needed" adds the key to dismissedTerminalPromptKeys and does NOT re-fire on next tick', () => {
    const state = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: makeNumbered('sig-a') },
    ]);
    _dispatchPendingPromptsForTesting(state);
    const overlay = document.querySelector<HTMLElement>('.terminal-prompt-overlay');
    const link = overlay!.querySelector<HTMLAnchorElement>('.dialog-shell-dismiss-link');
    expect(link).not.toBeNull();
    link!.click();

    expect(document.querySelector('.terminal-prompt-overlay')).toBeNull();
    expect(_activeOverlayKeyForTesting()).toBeNull();
    expect(_dismissedTerminalPromptKeysForTesting().has('sec-a::tA')).toBe(true);

    // Re-dispatch — same key is in the dismissed set, so dispatcher
    // skips even with a fresh signature.
    const stateWithNewSig = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: makeNumbered('sig-changed') },
    ]);
    _dispatchPendingPromptsForTesting(stateWithNewSig);
    expect(document.querySelector('.terminal-prompt-overlay')).toBeNull();
    expect(_activeOverlayKeyForTesting()).toBeNull();
  });

  it('dismissed bookkeeping is pruned when the server clears the pending entry (so a fresh prompt re-fires)', () => {
    const state = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: makeNumbered('sig-a') },
    ]);
    _dispatchPendingPromptsForTesting(state);
    document.querySelector<HTMLAnchorElement>('.dialog-shell-dismiss-link')!.click();
    expect(_dismissedTerminalPromptKeysForTesting().has('sec-a::tA')).toBe(true);

    // Server clears the pending entry — empty bell-state map.
    _dispatchPendingPromptsForTesting(new Map());
    expect(_dismissedTerminalPromptKeysForTesting().has('sec-a::tA')).toBe(false);

    // Fresh prompt arrives — overlay re-fires.
    _dispatchPendingPromptsForTesting(state);
    expect(document.querySelector('.terminal-prompt-overlay')).not.toBeNull();
  });

  it('minimized bookkeeping is pruned (with timeout cleared) when the server clears the pending entry', () => {
    const state = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: makeNumbered('sig-a') },
    ]);
    _dispatchPendingPromptsForTesting(state);
    document.querySelector<HTMLAnchorElement>('.dialog-shell-minimize-link')!.click();
    expect(_minimizedTerminalPromptsForTesting().size).toBe(1);

    _dispatchPendingPromptsForTesting(new Map());
    expect(_minimizedTerminalPromptsForTesting().size).toBe(0);
  });
});

/**
 * HS-8071 — recently-answered guard. The user reported a same-prompt
 * re-fire after answering: clicking a Claude-numbered choice, then
 * seeing the popup again moments later — except the second popup's
 * question hash had drifted (Claude TUI status-bar lines bled into the
 * captured question region) so the existing exact-signature dedup in
 * `lastDispatchedPromptSignatures` didn't catch it. The guard captures
 * (parser_id, choice-shape) at answer time and the dispatcher skips
 * any same-shape candidate within `RECENTLY_ANSWERED_TTL_MS`.
 */
describe('recently-answered guard (HS-8071)', () => {
  it('skips a same-shape candidate within the TTL even when the signature drifted', () => {
    const original = makeNumbered('claude-numbered:abcd1234:0');
    // User just answered — stamp the bookkeeping at "now".
    _markRecentlyAnsweredForTesting('sec-a', 'tA', original, Date.now());
    // Server re-detects the same prompt with a different hash (Claude
    // TUI status-bar contamination) — same parser_id, same choice
    // labels, just a different question_hash inside the signature.
    const driftedSig = makeNumbered('claude-numbered:99999999:0');
    const state = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: driftedSig },
    ]);
    _dispatchPendingPromptsForTesting(state);
    // Pre-fix the dispatcher would have surfaced a new overlay for the
    // drifted signature. Post-fix the guard suppresses it.
    expect(document.querySelector('.terminal-prompt-overlay')).toBeNull();
    expect(_activeOverlayKeyForTesting()).toBeNull();
  });

  it('does NOT skip when the choice shape differs (a genuinely different prompt is allowed through)', () => {
    const justAnswered = makeNumbered('sig-A');
    _markRecentlyAnsweredForTesting('sec-a', 'tA', justAnswered, Date.now());
    // Different choice list — this is a follow-up question, not the
    // same prompt re-fired.
    const followUp: NumberedMatch = {
      ...makeNumbered('sig-B'),
      choices: [
        { index: 0, label: 'Option A', highlighted: true },
        { index: 1, label: 'Option B', highlighted: false },
      ],
    };
    const state = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: followUp },
    ]);
    _dispatchPendingPromptsForTesting(state);
    expect(document.querySelector('.terminal-prompt-overlay')).not.toBeNull();
  });

  it('expires the entry after the TTL — an identical prompt that arrives later DOES surface', () => {
    const original = makeNumbered('sig-A');
    // Stamp it 10 seconds in the past — well past the 3-second TTL.
    _markRecentlyAnsweredForTesting('sec-a', 'tA', original, Date.now() - 10_000);
    const state = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: makeNumbered('sig-B') },
    ]);
    _dispatchPendingPromptsForTesting(state);
    expect(document.querySelector('.terminal-prompt-overlay')).not.toBeNull();
    // And the stale entry was pruned.
    expect(_recentlyAnsweredPromptsForTesting().has('sec-a::tA')).toBe(false);
  });

  it('does NOT cross-bleed across (secret, terminalId) — answering on project A leaves project B unguarded', () => {
    const justAnswered = makeNumbered('sig-A');
    _markRecentlyAnsweredForTesting('sec-a', 'tA', justAnswered, Date.now());
    const state = buildState([
      { secret: 'sec-b', terminalId: 'tB', match: makeNumbered('sig-B') },
    ]);
    _dispatchPendingPromptsForTesting(state);
    // The B project's prompt has the same shape but a different key —
    // surfaces normally.
    expect(document.querySelector('.terminal-prompt-overlay')).not.toBeNull();
  });

  it('records the answered shape when the user clicks a numbered choice', () => {
    const state = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: makeNumbered('sig-A') },
    ]);
    _dispatchPendingPromptsForTesting(state);
    // Click the highlighted choice — this fires `onSend`, which the
    // overlay calls before tearing down. Pre-click bookkeeping is empty.
    expect(_recentlyAnsweredPromptsForTesting().size).toBe(0);
    const firstChoice = document.querySelector<HTMLButtonElement>('.terminal-prompt-overlay-choice');
    expect(firstChoice).not.toBeNull();
    firstChoice!.click();
    // After the click, the recently-answered map should have one entry
    // with the parser_id + choice-shape captured.
    const recorded = _recentlyAnsweredPromptsForTesting().get('sec-a::tA');
    expect(recorded).toBeDefined();
    expect(recorded?.parserId).toBe('claude-numbered');
    expect(recorded?.choiceShape).toBe('i am using this for local development|exit');
  });
});

// HS-8210 Phase C (§58.5) — implicit channel-rule creation in
// `openCrossProjectOverlay::onSend`. The four contracts the design pins:
//   1. channel-bearing match + click → `appendAllowRule` writes a channel-
//      keyed rule (asserted via fetch-spy on /api/file-settings).
//   2. same match + "Don't remember" ticked → no rule is written.
//   3. non-channel match → no implicit channel rule (the legacy always-
//      allow checkbox path is unchanged).
//   4. channel match where settings already contain a matching channel
//      rule → dedupe (PATCH writes the existing list back unchanged).
describe('implicit channel-rule creation (HS-8210)', () => {
  function makeChannelMatch(signature: string): NumberedMatch {
    return {
      ...makeNumbered(signature),
      channel: 'server:hotsheet-channel',
    };
  }

  async function flushMicrotasks(): Promise<void> {
    // appendAllowRule does GET → PATCH; yield enough times for both to
    // resolve through the stubbed fetch.
    for (let i = 0; i < 4; i++) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  function getFetchMock(): ReturnType<typeof vi.fn> {
    return (globalThis as { fetch: typeof fetch }).fetch as unknown as ReturnType<typeof vi.fn>;
  }

  it('writes a channel-keyed rule when the user clicks a choice on a channel-bearing prompt without ticking opt-out', async () => {
    const state = buildState([
      { secret: 'origin-secret', terminalId: 'tA', match: makeChannelMatch('sig-channel') },
    ]);
    _dispatchPendingPromptsForTesting(state);
    const overlay = document.querySelector<HTMLElement>('.terminal-prompt-overlay');
    expect(overlay).not.toBeNull();
    // Channel footer is present; always-allow checkbox is not.
    expect(overlay!.querySelector('.terminal-prompt-overlay-channel-rule-row')).not.toBeNull();
    expect(overlay!.querySelector('.terminal-prompt-overlay-allow-rule-row')).toBeNull();

    overlay!.querySelector<HTMLButtonElement>('.terminal-prompt-overlay-choice[data-choice-index="0"]')!.click();
    await flushMicrotasks();

    // Find the PATCH /file-settings call that wrote the rule.
    const fetchMock = getFetchMock();
    const patchCall = fetchMock.mock.calls.find(call => {
      const url = String(call[0]);
      const opts = call[1] as { method?: string } | undefined;
      return url.includes('/api/file-settings') && opts?.method === 'PATCH';
    });
    expect(patchCall).toBeDefined();
    const bodyRaw = (patchCall![1] as { body?: string }).body ?? '{}';
    const body = JSON.parse(bodyRaw) as { terminal_prompt_allow_rules?: Array<{ parser_id: string; match_channel?: string; choice_index: number; question_hash: string }> };
    const rules = body.terminal_prompt_allow_rules ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0].parser_id).toBe('claude-numbered');
    expect(rules[0].match_channel).toBe('server:hotsheet-channel');
    expect(rules[0].choice_index).toBe(0);
    expect(rules[0].question_hash).toBe('');

    // X-Hotsheet-Secret carries the originating project's secret.
    const headers = (patchCall![1] as { headers?: Record<string, string> }).headers ?? {};
    expect(headers['X-Hotsheet-Secret']).toBe('origin-secret');
  });

  it('does NOT write a channel-keyed rule when the user ticks "Don\'t remember" before clicking', async () => {
    const state = buildState([
      { secret: 'origin-secret', terminalId: 'tA', match: makeChannelMatch('sig-channel') },
    ]);
    _dispatchPendingPromptsForTesting(state);
    const overlay = document.querySelector<HTMLElement>('.terminal-prompt-overlay');
    overlay!.querySelector<HTMLInputElement>('.terminal-prompt-overlay-channel-dont-remember')!.checked = true;
    overlay!.querySelector<HTMLButtonElement>('.terminal-prompt-overlay-choice[data-choice-index="0"]')!.click();
    await flushMicrotasks();

    const fetchMock = getFetchMock();
    const patchCall = fetchMock.mock.calls.find(call => {
      const url = String(call[0]);
      const opts = call[1] as { method?: string } | undefined;
      return url.includes('/api/file-settings') && opts?.method === 'PATCH';
    });
    expect(patchCall).toBeUndefined();
  });

  it('does NOT write an implicit channel rule for a non-channel-bearing numbered prompt', async () => {
    // makeNumbered() with no channel field — the always-allow checkbox
    // path is the only allow-list affordance and the user didn't tick it.
    const state = buildState([
      { secret: 'origin-secret', terminalId: 'tA', match: makeNumbered('sig-no-channel') },
    ]);
    _dispatchPendingPromptsForTesting(state);
    document.querySelector<HTMLButtonElement>('.terminal-prompt-overlay-choice[data-choice-index="0"]')!.click();
    await flushMicrotasks();

    const fetchMock = getFetchMock();
    const patchCall = fetchMock.mock.calls.find(call => {
      const url = String(call[0]);
      const opts = call[1] as { method?: string } | undefined;
      return url.includes('/api/file-settings') && opts?.method === 'PATCH';
    });
    expect(patchCall).toBeUndefined();
  });

  it('dedupes when an existing channel rule already covers the same (parser, channel, choice_index)', async () => {
    // Override the GET /file-settings response so the existing-rules
    // list already has the channel rule we're about to "create".
    const existingRule = {
      id: 'tp_existing',
      parser_id: 'claude-numbered',
      question_hash: '',
      choice_index: 0,
      match_channel: 'server:hotsheet-channel',
      created_at: '2026-05-01T00:00:00Z',
    };
    const fetchMock = getFetchMock();
    fetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (url.includes('/api/file-settings') && (opts?.method === undefined || opts.method === 'GET')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ terminal_prompt_allow_rules: [existingRule] }),
          text: () => Promise.resolve(''),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
      });
    });

    const state = buildState([
      { secret: 'origin-secret', terminalId: 'tA', match: makeChannelMatch('sig-channel') },
    ]);
    _dispatchPendingPromptsForTesting(state);
    document.querySelector<HTMLButtonElement>('.terminal-prompt-overlay-choice[data-choice-index="0"]')!.click();
    await flushMicrotasks();

    // The PATCH should still happen (appendAllowRule writes the cleaned
    // existing list back), but the body must contain only the original
    // rule — not a second one.
    const patchCall = fetchMock.mock.calls.find(call => {
      const url = String(call[0]);
      const o = call[1] as { method?: string } | undefined;
      return url.includes('/api/file-settings') && o?.method === 'PATCH';
    });
    expect(patchCall).toBeDefined();
    const bodyRaw = (patchCall![1] as { body?: string }).body ?? '{}';
    const body = JSON.parse(bodyRaw) as { terminal_prompt_allow_rules?: Array<{ id: string }> };
    const rules = body.terminal_prompt_allow_rules ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('tp_existing');
  });
});

/**
 * HS-8245 — inverts HS-8228's earlier precedence. When an AI tool
 * (Claude / Codex / etc., parser id in `AI_PARSER_IDS`) is detected at
 * an in-terminal prompt for a project, the §52 in-terminal overlay is
 * the authoritative surface (its borrow-terminal interaction sends
 * keystrokes the AI's TUI is already listening for). The §47 channel-
 * permission MCP popup is suppressed for the same project for as long
 * as that AI prompt is live in the server's `pendingPrompts`, AND any
 * mounted §47 popup for the same project is dismissed when the AI
 * candidate dispatches. Removed `dismissTerminalPromptOverlayForSecret`
 * tests — the helper itself was deleted (no callers under HS-8245).
 */
describe('HS-8245 — AI prompt detection drives §47 suppression', () => {
  it('exposes hasAiTerminalPromptForSecret() === true when the project has a live claude-numbered match', () => {
    expect(hasAiTerminalPromptForSecret('sec-a')).toBe(false);
    const state = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: makeNumbered('sig-a') },
    ]);
    _dispatchPendingPromptsForTesting(state);
    expect(hasAiTerminalPromptForSecret('sec-a')).toBe(true);
  });

  it('returns false for OTHER projects that do not have an AI-parser match', () => {
    const state = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: makeNumbered('sig-a') },
    ]);
    _dispatchPendingPromptsForTesting(state);
    expect(hasAiTerminalPromptForSecret('sec-a')).toBe(true);
    expect(hasAiTerminalPromptForSecret('sec-b')).toBe(false);
  });

  it('clears hasAiTerminalPromptForSecret() when the server clears its pendingPrompt', () => {
    const state = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: makeNumbered('sig-a') },
    ]);
    _dispatchPendingPromptsForTesting(state);
    expect(hasAiTerminalPromptForSecret('sec-a')).toBe(true);

    // Server cleared pendingPrompts — tick again with empty bell state.
    const empty: BellStateMap = new Map([
      ['sec-a', { anyTerminalPending: false, terminalIds: [], pendingPrompts: {} }],
    ]);
    _dispatchPendingPromptsForTesting(empty);
    expect(hasAiTerminalPromptForSecret('sec-a')).toBe(false);
  });

  it('dispatches the §52 overlay AND calls dismissPermissionPopupForSecret(secret) when the candidate is an AI parser', async () => {
    const state = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: makeNumbered('sig-a') },
    ]);
    _dispatchPendingPromptsForTesting(state);
    expect(_activeOverlayKeyForTesting()).toBe('sec-a::tA');
    // The dispatcher fires `void import('./permissionOverlay.js').then(...)`
    // which resolves asynchronously; vi.waitFor polls until the mock is
    // called or times out. Times out fast (~50 ms) so a regression where
    // the call never fires fails the test promptly.
    await vi.waitFor(() => {
      expect(dismissPermissionPopupMock).toHaveBeenCalledWith('sec-a');
    }, { timeout: 200 });
  });

  it('does NOT call dismissPermissionPopupForSecret for non-AI parsers (yesno / generic)', async () => {
    // yesno match — same secret as before, but parserId !== 'claude-numbered'.
    const yesno: MatchResult = {
      parserId: 'yesno',
      shape: 'yesno',
      question: 'Continue?',
      questionLines: ['Continue?'],
      signature: 'yn-sig',
      yesIsCapital: true,
      noIsCapital: false,
    };
    const state = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: yesno },
    ]);
    _dispatchPendingPromptsForTesting(state);
    expect(_activeOverlayKeyForTesting()).toBe('sec-a::tA');
    // Give the dispatcher's microtask queue time to drain — if a
    // regression fires the dynamic import for non-AI parsers, the
    // assertion below would catch it on the next tick.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(dismissPermissionPopupMock).not.toHaveBeenCalled();
  });

  it('tracks AI prompts even for generic-shape candidates that the candidate loop skipped', () => {
    // The candidate loop skips matches with `shape === 'generic'` (too high
    // false-positive risk to auto-surface), but if a future generic-shape
    // match somehow uses an AI parser id, the suppression flag for §47
    // should still fire. Today no AI parser produces generic shape, so this
    // test asserts the *detection* path is decoupled from the
    // *candidate-eligibility* path. Ensures a future Codex parser that
    // emits generic-shape during exploratory phases still suppresses §47.
    const aiGeneric: MatchResult = {
      parserId: 'claude-numbered', // pretend an AI parser produced generic
      shape: 'generic',
      question: 'open-ended',
      questionLines: ['open-ended'],
      signature: 'sig-g',
      rawText: 'open-ended',
    };
    const state = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: aiGeneric },
    ]);
    _dispatchPendingPromptsForTesting(state);
    // No overlay (generic-shape skipped from candidate loop) but the
    // detection set still records sec-a so §47 is suppressed.
    expect(_activeOverlayKeyForTesting()).toBeNull();
    expect(hasAiTerminalPromptForSecret('sec-a')).toBe(true);
  });
});

/**
 * HS-8294 — when the user picks a numbered choice on an AI-parser §52
 * overlay, the dispatcher must call
 * `permissionOverlay.dismissChannelPermissionForSecret(secret)` so the
 * channel server's still-pending MCP `permission_request` for the same
 * Claude decision doesn't surface §47 on the next channel-permission
 * poll. Cancel paths (Esc / X / "No response needed") and non-AI
 * parsers (yesno) MUST NOT trigger the dismiss — those don't represent
 * an answered Claude decision.
 *
 * The dynamic `import('./permissionOverlay.js')` inside `onSend`
 * resolves asynchronously; tests use `vi.waitFor` to poll the mock
 * with a tight timeout so a regression (the call never fires) fails
 * the test promptly rather than hanging.
 *
 * NOTE: the positive case here uses the FILE-LEVEL `dismissChannelPermissionMock`
 * which the `vi.mock` factory at the top of the file installs. The
 * negative cases below assert "no call" — those naturally pass either
 * way; they pin that the gate-logic in `onSend` never invokes the
 * dynamic import for non-AI parsers / cancel paths, which is what the
 * static analysis would catch as a regression.
 */
describe('HS-8294 — onSend dismisses channel permission for AI parser answers', () => {
  // NOTE: the positive case ("DOES call dismiss for AI parser numbered
  // answers") is covered by the integration test in
  // `permissionOverlay.test.ts::HS-8294 integration` which drives the
  // real bellPoll dispatcher + click against the un-mocked
  // permissionOverlay module and asserts on `dismissedRequestIds`. Vi's
  // synchronous `vi.mock` factory at this file's top intercepts
  // ONE dynamic-import call site (`dispatchPendingPrompts`'s mount-time
  // dismiss for §47, which the HS-8245 tests above pin) but lets the
  // SECOND `import('./permissionOverlay.js')` from `onSend` bypass —
  // the assertions here for the positive case would fail with `Number
  // of calls: 0` even though the real wiring works end-to-end.

  it('does NOT call dismissChannelPermissionForSecret for a yesno (non-AI) parser', async () => {
    const yesno: MatchResult = {
      parserId: 'yesno',
      shape: 'yesno',
      question: 'Continue?',
      questionLines: ['Continue?'],
      signature: 'yn-sig',
      yesIsCapital: true,
      noIsCapital: false,
    };
    const state = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: yesno },
    ]);
    _dispatchPendingPromptsForTesting(state);
    document.querySelector<HTMLButtonElement>('[data-yesno="yes"]')!.click();
    // Drain microtasks so a regression that DID fire the import would land.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(dismissChannelPermissionMock).not.toHaveBeenCalled();
  });

  it('does NOT call dismissChannelPermissionForSecret on Escape (cancel path) for an AI parser', async () => {
    const state = buildState([
      { secret: 'sec-a', terminalId: 'tA', match: makeNumbered('sig-A') },
    ]);
    _dispatchPendingPromptsForTesting(state);
    // The Esc capture handler routes through the shape's cancel-payload
    // send. extras.choiceIndex is undefined on cancel paths, so the
    // dismiss must NOT fire.
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    document.dispatchEvent(esc);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(dismissChannelPermissionMock).not.toHaveBeenCalled();
  });
});
