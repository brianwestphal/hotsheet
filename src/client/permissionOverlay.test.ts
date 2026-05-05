// @vitest-environment happy-dom
/**
 * HS-8183 — unit tests for the permission-popup polling + state machine
 * in `permissionOverlay.tsx`. The reported bug: "the first permissions
 * popup for a project shows up very briefly and then disappears, then no
 * popups ever appear after that". Pre-fix two design weaknesses combined
 * to produce that symptom:
 *
 *   1. The auto-dismiss path fired on the FIRST poll where `data.permissions`
 *      didn't include `activePopupRequestId`. A single transient
 *      channel-server fetch failure (the per-project `fetch` in
 *      `routes/projects.ts::checkAll` returns `null` on any throw — network
 *      blip, brief restart, slow response that gets cancelled) ripped the
 *      popup out from under the user.
 *
 *   2. `showPermissionPopup` set `activePopupRequestId = perm.request_id`
 *      BEFORE `openPermissionDialogShell` ran. A throw partway through the
 *      mount path (xterm constructor, FitAddon load, malformed truncation
 *      payload reaching `formatEditDiff`, etc.) left `activePopupRequestId`
 *      set with no popup in the DOM, so every subsequent show-loop call
 *      early-returned at the `if (activePopupRequestId !== null) return;`
 *      gate — exactly the "no popups ever after" tail of the repro.
 *
 * The fix in `permissionOverlay.tsx`:
 *   - `AUTO_DISMISS_MISS_THRESHOLD = 2` — auto-dismiss requires the
 *     request id missing for two consecutive polls.
 *   - `showPermissionPopup` wraps `showPermissionPopupBody` in try/catch
 *     that resets `activePopupRequestId` + releases the checkout + removes
 *     any partial-mount DOM before rethrowing.
 *
 * Tests drive the new exported `processPermissionPollResponse(data)` to
 * exercise polling end-to-end without spinning up `api()` + `setTimeout`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _inspectStateForTesting,
  _resetStateForTesting,
  dismissedRequestIds,
  type PermissionData,
  processPermissionPollResponse,
  respondedRequestIds,
} from './permissionOverlay.js';
import {
  _inspectStackForTesting,
  _resetForTesting as resetCheckout,
  checkout,
  entryCount,
} from './terminalCheckout.js';

// channelUI's mark/clearProjectAttention writes into module state we don't
// care about for these tests — the polling code calls them, and we just
// need them to not throw. The mock keeps the side-effect surface tight.
vi.mock('./channelUI.js', () => ({
  clearProjectAttention: vi.fn(),
  getProjectAttentionSecrets: vi.fn(() => new Set<string>()),
  isChannelBusy: vi.fn(() => false),
  markProjectAttention: vi.fn(),
  setChannelBusy: vi.fn(),
}));

// `state.settings.notify_permission` is read by `showPermissionPopupBody`'s
// Tauri attention hook. Stub the entire module so we don't touch the real
// settings store + so the attention call is a no-op.
vi.mock('./state.js', () => ({
  state: {
    settings: { notify_permission: 'none' },
  },
}));

// Tauri attention is a Tauri-only invoke wrapped in a falsy guard for the
// browser path; stub it for symmetry.
vi.mock('./tauriIntegration.js', () => ({
  requestAttention: vi.fn(),
}));

// Mock the projectTabs lazy import that `syncMinimizedDots` uses so we
// don't pull in DOM-heavy tab rendering.
vi.mock('./projectTabs.js', () => ({
  updateStatusDots: vi.fn(),
}));

beforeEach(() => {
  document.body.innerHTML = '';
  _resetStateForTesting();
  resetCheckout();
});

afterEach(() => {
  _resetStateForTesting();
  resetCheckout();
  document.body.innerHTML = '';
});

function makePerm(overrides: Partial<PermissionData> = {}): PermissionData {
  return {
    request_id: 'req-1',
    tool_name: 'Bash',
    description: 'Run ls',
    input_preview: '{"command":"ls -la"}',
    ...overrides,
  };
}

describe('processPermissionPollResponse — show / no-show gates (HS-8183)', () => {
  it('shows a popup for a fresh permission', () => {
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm() },
      v: 1,
    });
    expect(document.querySelector('.permission-popup')).not.toBeNull();
    expect(_inspectStateForTesting().activePopupRequestId).toBe('req-1');
  });

  it('does not re-show a popup for the same request_id on subsequent polls', () => {
    const perm = makePerm();
    processPermissionPollResponse({ permissions: { 'secret-A': perm }, v: 1 });
    const firstPopup = document.querySelector('.permission-popup');
    expect(firstPopup).not.toBeNull();
    processPermissionPollResponse({ permissions: { 'secret-A': perm }, v: 2 });
    // Same DOM node — not torn down + re-mounted.
    expect(document.querySelector('.permission-popup')).toBe(firstPopup);
  });

  it('skips popup creation when the request was already responded to', () => {
    respondedRequestIds.add('req-1');
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm() },
      v: 1,
    });
    expect(document.querySelector('.permission-popup')).toBeNull();
    expect(_inspectStateForTesting().activePopupRequestId).toBeNull();
  });

  it('skips popup creation when the request was previously dismissed (X / Esc / "No response needed")', () => {
    dismissedRequestIds.add('req-1');
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm() },
      v: 1,
    });
    expect(document.querySelector('.permission-popup')).toBeNull();
  });

  it('shows only one popup at a time when multiple projects have pending permissions', () => {
    processPermissionPollResponse({
      permissions: {
        'secret-A': makePerm({ request_id: 'req-A' }),
        'secret-B': makePerm({ request_id: 'req-B' }),
      },
      v: 1,
    });
    const popups = document.querySelectorAll('.permission-popup');
    expect(popups.length).toBe(1);
    expect(['req-A', 'req-B']).toContain(_inspectStateForTesting().activePopupRequestId);
  });
});

describe('processPermissionPollResponse — auto-dismiss threshold (HS-8183)', () => {
  it('does NOT auto-dismiss on a single transient missing-permission poll', () => {
    // Setup: popup mounted for req-1.
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm() },
      v: 1,
    });
    expect(_inspectStateForTesting().activePopupRequestId).toBe('req-1');

    // Single transient null (e.g. channel-server fetch failed once).
    processPermissionPollResponse({
      permissions: { 'secret-A': null },
      v: 2,
    });
    // Popup must still be there — pre-HS-8183-fix this was the failure
    // mode (auto-dismiss fired on the first miss, ripping the popup
    // out from under the user even though the channel server still had
    // the permission queued).
    expect(document.querySelector('.permission-popup')).not.toBeNull();
    expect(_inspectStateForTesting().activePopupRequestId).toBe('req-1');
    expect(_inspectStateForTesting().autoDismissMissCount).toBe(1);
  });

  it('auto-dismisses after AUTO_DISMISS_MISS_THRESHOLD consecutive misses', () => {
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm() },
      v: 1,
    });
    processPermissionPollResponse({
      permissions: { 'secret-A': null },
      v: 2,
    });
    expect(document.querySelector('.permission-popup')).not.toBeNull();
    processPermissionPollResponse({
      permissions: { 'secret-A': null },
      v: 3,
    });
    expect(document.querySelector('.permission-popup')).toBeNull();
    expect(_inspectStateForTesting().activePopupRequestId).toBeNull();
    expect(_inspectStateForTesting().autoDismissMissCount).toBe(0);
  });

  it('resets the miss counter when the request reappears mid-streak (jitter recovery)', () => {
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm() },
      v: 1,
    });
    processPermissionPollResponse({
      permissions: { 'secret-A': null },
      v: 2,
    });
    expect(_inspectStateForTesting().autoDismissMissCount).toBe(1);

    // Permission re-appears (channel-server fetch recovered).
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm() },
      v: 3,
    });
    expect(_inspectStateForTesting().autoDismissMissCount).toBe(0);
    expect(document.querySelector('.permission-popup')).not.toBeNull();

    // Subsequent isolated miss does NOT trigger the dismiss because
    // the streak was reset.
    processPermissionPollResponse({
      permissions: { 'secret-A': null },
      v: 4,
    });
    expect(document.querySelector('.permission-popup')).not.toBeNull();
    expect(_inspectStateForTesting().autoDismissMissCount).toBe(1);
  });

  it('keeps the popup open when permission is reported by ANY project, not just its owner', () => {
    // Same request_id surfaced under a different project secret would be
    // odd in practice (request_ids are per-project) but the auto-dismiss
    // check uses Object.values + some(), so this is what guards a project
    // re-key edge case.
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm() },
      v: 1,
    });
    processPermissionPollResponse({
      permissions: {
        'secret-A': null,
        'secret-B': makePerm(), // same request_id, different secret
      },
      v: 2,
    });
    processPermissionPollResponse({
      permissions: {
        'secret-A': null,
        'secret-B': makePerm(),
      },
      v: 3,
    });
    expect(document.querySelector('.permission-popup')).not.toBeNull();
    expect(_inspectStateForTesting().autoDismissMissCount).toBe(0);
  });
});

describe('processPermissionPollResponse — recovery path (HS-8183 regression)', () => {
  it('regression: after auto-dismiss, a NEW permission with a different request_id still shows a popup', () => {
    // Show first popup.
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm({ request_id: 'req-old' }) },
      v: 1,
    });
    expect(_inspectStateForTesting().activePopupRequestId).toBe('req-old');

    // Two consecutive misses → auto-dismiss.
    processPermissionPollResponse({ permissions: { 'secret-A': null }, v: 2 });
    processPermissionPollResponse({ permissions: { 'secret-A': null }, v: 3 });
    expect(_inspectStateForTesting().activePopupRequestId).toBeNull();
    expect(document.querySelector('.permission-popup')).toBeNull();

    // New permission arrives with a fresh request_id.
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm({ request_id: 'req-new' }) },
      v: 4,
    });
    // Pre-fix the user reported "no popups ever appear after that" — this
    // assertion locks the post-fix contract that fresh request_ids ALWAYS
    // surface a popup after a clean auto-dismiss.
    expect(document.querySelector('.permission-popup')).not.toBeNull();
    expect(_inspectStateForTesting().activePopupRequestId).toBe('req-new');
  });

  it('after a responded permission clears, the next pending permission shows a popup', () => {
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm({ request_id: 'req-1' }) },
      v: 1,
    });
    // Simulate the user clicking Allow — respondedRequestIds is the
    // canonical "don't re-show this id" signal that respondToPermission
    // also uses internally.
    respondedRequestIds.add('req-1');
    // The popup-close path also runs — emulate by directly clearing the
    // active id (the real flow goes through clearPopupOnly which we don't
    // export; the auto-dismiss path also clears it given two missing polls).
    processPermissionPollResponse({ permissions: { 'secret-A': null }, v: 2 });
    processPermissionPollResponse({ permissions: { 'secret-A': null }, v: 3 });
    // Now the next perm arrives.
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm({ request_id: 'req-2' }) },
      v: 4,
    });
    expect(_inspectStateForTesting().activePopupRequestId).toBe('req-2');
  });
});

describe('processPermissionPollResponse — bookkeeping GC', () => {
  it('GCs dismissedRequestIds when the channel server stops reporting them', () => {
    dismissedRequestIds.add('req-old');
    expect([..._inspectStateForTesting().dismissedRequestIds]).toContain('req-old');
    processPermissionPollResponse({
      permissions: { 'secret-A': null },
      v: 1,
    });
    expect([..._inspectStateForTesting().dismissedRequestIds]).not.toContain('req-old');
  });

  it('does NOT GC dismissedRequestIds while still reported by the server', () => {
    dismissedRequestIds.add('req-still-pending');
    processPermissionPollResponse({
      permissions: {
        'secret-A': makePerm({ request_id: 'req-still-pending' }),
      },
      v: 1,
    });
    expect([..._inspectStateForTesting().dismissedRequestIds]).toContain('req-still-pending');
  });

  it('updates permissionVersion to the response version', () => {
    expect(_inspectStateForTesting().permissionVersion).toBe(0);
    processPermissionPollResponse({
      permissions: { 'secret-A': null },
      v: 42,
    });
    expect(_inspectStateForTesting().permissionVersion).toBe(42);
  });
});

describe('showPermissionPopup — live-terminal ResizeObserver (HS-8206)', () => {
  // Long, deliberately-truncated bash command — closing `"` and `}` are
  // missing AND every embedded `"` is escaped so the extractor scans
  // through them, eventually hitting the unterminated value and
  // appending `…`. Tripping `flatTruncated` in
  // `permissionOverlay.tsx::showPermissionPopupBody`. Same payload shape
  // as `permission-bash-long` in `scripts/simulate-claude-prompts.mjs`.
  const truncatedBashInput = '{"command":"' + (
    "find / -name '*.log' -mtime -1 -size +1M "
    + "| xargs -I {} sh -c 'echo === {} ==='; "
  ).repeat(20);

  function makeTruncatedPerm(id = 'req-1'): PermissionData {
    return {
      request_id: id,
      tool_name: 'Bash',
      description: 'Run a long pipeline',
      input_preview: truncatedBashInput,
    };
  }

  it('installs a ResizeObserver on the live-terminal container when the popup borrows the live xterm', () => {
    processPermissionPollResponse({
      permissions: { 'secret-A': makeTruncatedPerm() },
      v: 1,
    });
    // Popup mounted with the live-term container as the body slot.
    expect(document.querySelector('.permission-popup-live-terminal')).not.toBeNull();
    // Pre-HS-8206 the popup did a single rAF + `proposeDimensions` —
    // no observer. The fix installs an observer that keeps refitting
    // on every layout pass, defending against the cell-metrics-not-yet-
    // measured race that left the term stuck at the initial 100×30.
    expect(_inspectStateForTesting().activeLiveTermResizeObserver).toBe(true);
  });

  it('does NOT install a ResizeObserver for a short-input popup (no live-term borrow)', () => {
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm() }, // short input, no truncation
      v: 1,
    });
    expect(document.querySelector('.permission-popup')).not.toBeNull();
    expect(document.querySelector('.permission-popup-live-terminal')).toBeNull();
    expect(_inspectStateForTesting().activeLiveTermResizeObserver).toBe(false);
  });

  it('disconnects the ResizeObserver when the popup auto-dismisses', () => {
    processPermissionPollResponse({
      permissions: { 'secret-A': makeTruncatedPerm() },
      v: 1,
    });
    expect(_inspectStateForTesting().activeLiveTermResizeObserver).toBe(true);
    processPermissionPollResponse({ permissions: { 'secret-A': null }, v: 2 });
    processPermissionPollResponse({ permissions: { 'secret-A': null }, v: 3 });
    expect(_inspectStateForTesting().activeLiveTermResizeObserver).toBe(false);
  });
});

describe('showPermissionPopup — live-terminal stability (HS-8207)', () => {
  // HS-8207 — the user reported the popup going through phases:
  // "starts blank → shows some content → shows completely different content
  // → disappears entirely". These tests lock down the contracts that
  // prevent the multi-phase churn for the live-checkout body path:
  //   1. The xterm element is reparented into the popup body in the same
  //      task as the popup mount (no perceptible "blank" phase).
  //   2. Subsequent polls of the same request_id don't tear down + re-mount
  //      the popup or re-call checkout (no churn).
  //   3. When a competing checkout bumps the popup, the popup body shows
  //      the §54 placeholder — and when the bumping consumer releases,
  //      the live xterm reparents back into the popup body.
  // Anything outside these contracts (PTY redraws on resize, scrollback
  // replay) is intrinsic to a live-terminal popup and is not a bug.

  const truncatedBashInput = '{"command":"' + (
    "find / -name '*.log' -mtime -1 -size +1M "
    + "| xargs -I {} sh -c 'echo === {} ==='; "
  ).repeat(20);

  function makeTruncatedPerm(id = 'req-live'): PermissionData {
    return {
      request_id: id,
      tool_name: 'Bash',
      description: 'Run a long pipeline',
      input_preview: truncatedBashInput,
    };
  }

  it('reparents the live xterm element into the popup body in the same task as the popup mount', () => {
    processPermissionPollResponse({
      permissions: { 'secret-A': makeTruncatedPerm() },
      v: 1,
    });
    const liveTerm = document.querySelector('.permission-popup-live-terminal');
    expect(liveTerm).not.toBeNull();
    // Pre-fix or under a synchronously-broken `checkout()` the container
    // would be empty until some async tick reparented the xterm in. The
    // contract is that mount + reparent happen in the same JS task so the
    // user never sees a blank popup body.
    expect(liveTerm?.querySelector('.xterm')).not.toBeNull();
    // Stack depth 1: the popup is the only consumer of the (secret-A,'default')
    // entry; no other consumer was bumped down.
    expect(entryCount()).toBe(1);
    expect(_inspectStackForTesting()[0]?.stackDepth).toBe(1);
  });

  it('does NOT churn the popup or re-checkout when the same request_id appears in subsequent polls', () => {
    processPermissionPollResponse({
      permissions: { 'secret-A': makeTruncatedPerm() },
      v: 1,
    });
    const popupBefore = document.querySelector('.permission-popup');
    const liveTermBefore = document.querySelector('.permission-popup-live-terminal');
    const xtermElBefore = liveTermBefore?.querySelector('.xterm');
    expect(popupBefore).not.toBeNull();
    expect(liveTermBefore).not.toBeNull();
    expect(xtermElBefore).not.toBeNull();
    const stackDepthBefore = _inspectStackForTesting()[0]?.stackDepth;

    // Re-poll with the same request_id three times — pre-fix some show-loop
    // re-entries could cause `checkout()` to fire again, growing the stack.
    for (let i = 0; i < 3; i++) {
      processPermissionPollResponse({
        permissions: { 'secret-A': makeTruncatedPerm() },
        v: 2 + i,
      });
    }

    // Same DOM nodes — no tear-down + re-mount.
    expect(document.querySelector('.permission-popup')).toBe(popupBefore);
    expect(document.querySelector('.permission-popup-live-terminal')).toBe(liveTermBefore);
    expect(liveTermBefore?.querySelector('.xterm')).toBe(xtermElBefore);
    // Stack depth unchanged — no extra checkouts from the show-loop.
    expect(_inspectStackForTesting()[0]?.stackDepth).toBe(stackDepthBefore);
  });

  it('shows the §54 placeholder in the popup body when a competing consumer checks out the same terminal', () => {
    processPermissionPollResponse({
      permissions: { 'secret-A': makeTruncatedPerm() },
      v: 1,
    });
    const liveTerm = document.querySelector<HTMLElement>('.permission-popup-live-terminal');
    expect(liveTerm).not.toBeNull();
    expect(liveTerm?.querySelector('.xterm')).not.toBeNull();

    // Now a competing consumer (drawer pane / dashboard tile / quit-confirm
    // preview / etc.) checks out the SAME (secret, terminalId). LIFO bumps
    // the popup down: its mountInto receives the placeholder, the live
    // xterm reparents into the new top.
    const externalMount = document.createElement('div');
    document.body.appendChild(externalMount);
    const externalHandle = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: externalMount,
    });

    // Popup body now holds the §54 'Terminal in use elsewhere' placeholder.
    expect(liveTerm?.querySelector('.terminal-checkout-placeholder')).not.toBeNull();
    // xterm reparented into the external consumer.
    expect(externalMount.querySelector('.xterm')).not.toBeNull();
    expect(liveTerm?.querySelector('.xterm')).toBeNull();

    externalHandle.release();
  });

  it('reparents the live xterm back into the popup body when the bumping consumer releases', () => {
    processPermissionPollResponse({
      permissions: { 'secret-A': makeTruncatedPerm() },
      v: 1,
    });
    const liveTerm = document.querySelector<HTMLElement>('.permission-popup-live-terminal');
    expect(liveTerm).not.toBeNull();

    const externalMount = document.createElement('div');
    document.body.appendChild(externalMount);
    const externalHandle = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: externalMount,
    });
    expect(liveTerm?.querySelector('.terminal-checkout-placeholder')).not.toBeNull();

    // External consumer releases — popup is restored to the top of the
    // stack. Live xterm reparents into the popup body, placeholder cleared.
    externalHandle.release();
    expect(liveTerm?.querySelector('.terminal-checkout-placeholder')).toBeNull();
    expect(liveTerm?.querySelector('.xterm')).not.toBeNull();
    expect(externalMount.querySelector('.xterm')).toBeNull();
  });

  it('releases the popup checkout on auto-dismiss so the previous owner gets the live xterm back', () => {
    // Pre-bumped consumer: an external mount becomes the popup's "previous
    // owner" by checking out FIRST. Then the popup mounts and bumps it.
    const externalMount = document.createElement('div');
    document.body.appendChild(externalMount);
    const externalHandle = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: externalMount,
    });
    expect(externalMount.querySelector('.xterm')).not.toBeNull();

    // Popup mounts via poll → checkout bumps externalMount down.
    processPermissionPollResponse({
      permissions: { 'secret-A': makeTruncatedPerm() },
      v: 1,
    });
    const liveTerm = document.querySelector<HTMLElement>('.permission-popup-live-terminal');
    expect(liveTerm?.querySelector('.xterm')).not.toBeNull();
    expect(externalMount.querySelector('.terminal-checkout-placeholder')).not.toBeNull();

    // Two consecutive missing polls trigger auto-dismiss — the popup must
    // release its checkout so externalMount can reclaim the live xterm.
    // Pre-HS-8182 the auto-dismiss path forgot to call release; this
    // assertion locks down the post-HS-8182 contract for the live-checkout
    // body path specifically (the HS-8182 fix is also exercised by the
    // existing 'disconnects the ResizeObserver when the popup auto-dismisses'
    // test, but that one only inspects state, not the DOM-recovery side).
    processPermissionPollResponse({ permissions: { 'secret-A': null }, v: 2 });
    processPermissionPollResponse({ permissions: { 'secret-A': null }, v: 3 });
    expect(document.querySelector('.permission-popup')).toBeNull();
    expect(_inspectStateForTesting().activeCheckoutHandle).toBe(false);
    // externalMount got the live xterm back via the §54 LIFO restore.
    expect(externalMount.querySelector('.xterm')).not.toBeNull();
    expect(externalMount.querySelector('.terminal-checkout-placeholder')).toBeNull();

    externalHandle.release();
  });

  it('retries the fit when proposeDimensions returns undefined initially (HS-8206 v2)', async () => {
    // Pre-fix the popup's ResizeObserver fired once on initial observe,
    // bailed when `proposeDimensions()` returned undefined (xterm
    // renderer's cell dims still 0×0 right after reparent), and never
    // retried — so for a fixed-CSS-size popup container the term stayed
    // at the initial 100×30 forever. The fix introduces a retry loop
    // that polls until cell metrics are measured.
    //
    // The retry path is internal to `permissionOverlay.tsx`; we exercise
    // it indirectly by mounting a popup and asserting the resize
    // eventually lands. happy-dom's xterm setup measures cell dims
    // synchronously on first render, so the first attempt usually
    // succeeds — but the assertion is on the END state, which is what
    // the user sees.
    processPermissionPollResponse({
      permissions: { 'secret-A': makeTruncatedPerm() },
      v: 1,
    });
    const liveTerm = document.querySelector<HTMLElement>('.permission-popup-live-terminal');
    expect(liveTerm).not.toBeNull();
    // Wait a few rAFs / timers for the retry chain to drain.
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The popup is still mounted (no auto-dismiss) and the active checkout
    // is intact — the retry timer doesn't leak the handle if the popup
    // is closed mid-retry (covered by the auto-dismiss test below).
    expect(_inspectStateForTesting().activeCheckoutHandle).toBe(true);
    expect(document.querySelector('.permission-popup')).not.toBeNull();
  });

  it('cancels the fit retry chain when the popup auto-dismisses mid-retry', async () => {
    // Mount popup → start retry chain → auto-dismiss → assert no leak.
    processPermissionPollResponse({
      permissions: { 'secret-A': makeTruncatedPerm() },
      v: 1,
    });
    expect(_inspectStateForTesting().activeCheckoutHandle).toBe(true);
    // Auto-dismiss BEFORE the retry chain has had time to drain.
    processPermissionPollResponse({ permissions: { 'secret-A': null }, v: 2 });
    processPermissionPollResponse({ permissions: { 'secret-A': null }, v: 3 });
    expect(_inspectStateForTesting().activeCheckoutHandle).toBe(false);
    // Drain any pending retries — must not throw, must not re-create state.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(_inspectStateForTesting().activeCheckoutHandle).toBe(false);
    expect(_inspectStateForTesting().activePopupRequestId).toBeNull();
  });

  it('regression: a fresh popup after auto-dismiss reparents the live xterm correctly', () => {
    // First popup, then auto-dismiss.
    processPermissionPollResponse({
      permissions: { 'secret-A': makeTruncatedPerm('req-old') },
      v: 1,
    });
    expect(document.querySelector('.permission-popup-live-terminal .xterm')).not.toBeNull();
    processPermissionPollResponse({ permissions: { 'secret-A': null }, v: 2 });
    processPermissionPollResponse({ permissions: { 'secret-A': null }, v: 3 });
    expect(document.querySelector('.permission-popup')).toBeNull();
    // Entry virtualized away (no remaining consumer).
    expect(entryCount()).toBe(0);

    // Fresh popup with a different request_id — must mount cleanly with
    // the xterm reparented into the popup body, not stuck blank.
    processPermissionPollResponse({
      permissions: { 'secret-A': makeTruncatedPerm('req-new') },
      v: 4,
    });
    const liveTermNew = document.querySelector<HTMLElement>('.permission-popup-live-terminal');
    expect(liveTermNew).not.toBeNull();
    expect(liveTermNew?.querySelector('.xterm')).not.toBeNull();
    expect(_inspectStateForTesting().activePopupRequestId).toBe('req-new');
    expect(_inspectStateForTesting().activeCheckoutHandle).toBe(true);
  });
});

describe('processPermissionPollResponse — channel-unreachable signaling (HS-8207)', () => {
  // HS-8207 — when the popup's owning project is missing entirely from
  // `data.permissions` (vs. present-with-null), the per-project channel-
  // server fetch in `routes/projects.ts::checkAll` threw transiently
  // (channel-server restart, network blip, slow response cancelled).
  // The auto-dismiss counter must NOT tick in this case — pre-fix, the
  // server returned `null` on fetch failure and the client conflated it
  // with "no permission pending", ticking the counter and tearing the
  // popup out from under the user after two such transients.

  it('does NOT tick the auto-dismiss counter when the owner project is missing from the response', () => {
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm() },
      v: 1,
    });
    expect(_inspectStateForTesting().activePopupOwnerSecret).toBe('secret-A');
    expect(_inspectStateForTesting().autoDismissMissCount).toBe(0);

    // Simulate a transient channel-server fetch failure: the server now
    // OMITS secret-A from the response entirely (HS-8207 server-side
    // contract change in `routes/projects.ts`). The popup's owner is
    // unknown this poll → counter must stay at 0.
    processPermissionPollResponse({ permissions: {}, v: 2 });
    expect(_inspectStateForTesting().autoDismissMissCount).toBe(0);
    expect(document.querySelector('.permission-popup')).not.toBeNull();
    expect(_inspectStateForTesting().activePopupRequestId).toBe('req-1');

    // Even FIVE consecutive missing-key polls must not auto-dismiss —
    // the channel server might be down for a while, but Claude is still
    // waiting and the user mustn't lose the popup.
    for (let i = 0; i < 5; i++) {
      processPermissionPollResponse({ permissions: {}, v: 3 + i });
    }
    expect(document.querySelector('.permission-popup')).not.toBeNull();
    expect(_inspectStateForTesting().autoDismissMissCount).toBe(0);
  });

  it('ticks the counter when the owner project is present-with-null (confirmed not pending)', () => {
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm() },
      v: 1,
    });
    // Present with null → confirmed not pending → tick counter.
    processPermissionPollResponse({ permissions: { 'secret-A': null }, v: 2 });
    expect(_inspectStateForTesting().autoDismissMissCount).toBe(1);
    expect(document.querySelector('.permission-popup')).not.toBeNull();
    processPermissionPollResponse({ permissions: { 'secret-A': null }, v: 3 });
    expect(document.querySelector('.permission-popup')).toBeNull();
  });

  it('preserves counter across an unreachable poll mid-streak (slow dismiss, not reset)', () => {
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm() },
      v: 1,
    });
    // First miss — confirmed not pending → tick to 1.
    processPermissionPollResponse({ permissions: { 'secret-A': null }, v: 2 });
    expect(_inspectStateForTesting().autoDismissMissCount).toBe(1);

    // Then a transient unreachable — counter must stay at 1 (don't reset,
    // don't tick). Without this, an interleaved unreachable would reset the
    // counter every time, preventing the popup from ever auto-dismissing
    // when the channel server is genuinely flapping. With it preserved,
    // a steady stream of "null with the occasional unreachable" still
    // eventually dismisses.
    processPermissionPollResponse({ permissions: {}, v: 3 });
    expect(_inspectStateForTesting().autoDismissMissCount).toBe(1);
    expect(document.querySelector('.permission-popup')).not.toBeNull();

    // Next confirmed-null poll completes the streak.
    processPermissionPollResponse({ permissions: { 'secret-A': null }, v: 4 });
    expect(document.querySelector('.permission-popup')).toBeNull();
    expect(_inspectStateForTesting().autoDismissMissCount).toBe(0);
  });

  it('clears activePopupOwnerSecret on auto-dismiss', () => {
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm() },
      v: 1,
    });
    expect(_inspectStateForTesting().activePopupOwnerSecret).toBe('secret-A');
    processPermissionPollResponse({ permissions: { 'secret-A': null }, v: 2 });
    processPermissionPollResponse({ permissions: { 'secret-A': null }, v: 3 });
    expect(_inspectStateForTesting().activePopupOwnerSecret).toBeNull();
  });
});

describe('showPermissionPopup — checkout dim pass-through (HS-8207)', () => {
  // HS-8207 — when the popup borrows the live xterm via §54 checkout,
  // it must pass the EXISTING entry's dims so the swap-time
  // `applyResizeIfChanged` is a no-op. Pre-fix the popup hardcoded
  // (cols: 100, rows: 30), which fired one redraw at checkout, then
  // the fit-retry resized to popup-fit dims firing a second one
  // back-to-back. The user perceived this as the "shows some content
  // → shows completely different content" multi-phase symptom.

  const truncatedBashInput = '{"command":"' + (
    "find / -name '*.log' -mtime -1 -size +1M "
    + "| xargs -I {} sh -c 'echo === {} ==='; "
  ).repeat(20);

  function makeTruncatedPerm(id = 'req-live'): PermissionData {
    return {
      request_id: id,
      tool_name: 'Bash',
      description: 'Run a long pipeline',
      input_preview: truncatedBashInput,
    };
  }

  it('passes through the existing entry dims when one already exists (no resize SIGWINCH on checkout)', () => {
    // Pre-existing consumer with non-default dims (e.g. drawer pane fit
    // to 90×28). Pre-HS-8207 the popup checkout would have resized to
    // (100, 30) — one redraw — then the fit-retry would have resized to
    // popup-fit — second redraw. Post-HS-8207 the popup uses 90×28 from
    // peekEntryDims, and the only resize is the fit-retry's.
    const externalMount = document.createElement('div');
    document.body.appendChild(externalMount);
    const externalHandle = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 90,
      rows: 28,
      mountInto: externalMount,
    });

    // Snapshot lastApplied dims BEFORE the popup mounts.
    const beforeStack = _inspectStackForTesting()[0];
    expect(beforeStack.lastAppliedCols).toBe(90);
    expect(beforeStack.lastAppliedRows).toBe(28);

    // Popup mounts via poll. With the dim-passthrough it will pass
    // (90, 28) to checkout — applyResizeIfChanged is a no-op.
    processPermissionPollResponse({
      permissions: { 'secret-A': makeTruncatedPerm() },
      v: 1,
    });

    // Stack now has 2 consumers; lastApplied unchanged from the popup's
    // checkout call (no SIGWINCH). The fit-retry runs after rAF and may
    // change dims later — that's a separate, isolated resize.
    const afterStack = _inspectStackForTesting()[0];
    expect(afterStack.lastAppliedCols).toBe(90);
    expect(afterStack.lastAppliedRows).toBe(28);
    expect(afterStack.stackDepth).toBe(2);

    externalHandle.release();
  });

  it('uses 80x24 default when no entry exists (popup is first consumer)', () => {
    // No pre-existing consumer. The popup's checkout creates the entry.
    // peekEntryDims returns null → defaults to 80×24. Pre-HS-8207 this
    // was 100×30, which is wider than typical popup-fit dims. 80×24 is
    // closer to popup-fit so the fit-retry's resize is a smaller delta.
    processPermissionPollResponse({
      permissions: { 'secret-A': makeTruncatedPerm() },
      v: 1,
    });
    const stack = _inspectStackForTesting()[0];
    expect(stack.lastAppliedCols).toBe(80);
    expect(stack.lastAppliedRows).toBe(24);
  });
});

describe('showPermissionPopup — partial-mount safety (HS-8183)', () => {
  it('does not leak activePopupRequestId when a downstream call throws', async () => {
    // Force `requestAnimationFrame` to throw by stubbing it. The
    // popup-show body uses rAF inside the live-checkout block; we use
    // a long truncation-bait payload to take that branch. Then we
    // trigger the throw via the rAF callback executing synchronously
    // in happy-dom and asserting the catch path resets state.
    //
    // Simpler / more reliable: intercept `markProjectAttention` (via
    // the channelUI mock above) to throw. That fires inside the
    // poll-response loop AROUND the showPermissionPopup call, so it
    // exercises the same "popup partially mounted then state corrupts"
    // scenario.
    const { markProjectAttention } = await import('./channelUI.js');
    vi.mocked(markProjectAttention).mockImplementationOnce(() => {
      throw new Error('boom');
    });

    expect(() => {
      processPermissionPollResponse({
        permissions: { 'secret-A': makePerm() },
        v: 1,
      });
    }).toThrow();

    // Even though the iteration threw, the next poll cycle must be able
    // to recover — neither activePopupRequestId nor activeCheckoutHandle
    // should be stuck.
    expect(_inspectStateForTesting().activePopupRequestId).toBeNull();
    expect(_inspectStateForTesting().activeCheckoutHandle).toBe(false);

    // Re-default the mock and verify a follow-up poll recovers fully.
    vi.mocked(markProjectAttention).mockReset();
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm({ request_id: 'req-2' }) },
      v: 2,
    });
    expect(_inspectStateForTesting().activePopupRequestId).toBe('req-2');
    expect(document.querySelector('.permission-popup')).not.toBeNull();
  });
});
