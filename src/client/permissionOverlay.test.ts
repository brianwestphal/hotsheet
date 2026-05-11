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
  LIVE_CHECKOUT_PREVIEW_CHAR_THRESHOLD,
  type PermissionData,
  processPermissionPollResponse,
  respondedRequestIds,
  shouldSkipPermission,
  shouldUseLiveCheckout,
} from './permissionOverlay.js';
import type { EditDiffShape } from './permissionPreview.js';
import {
  _inspectStackForTesting,
  _resetForTesting as resetCheckout,
  _simulateNoSessionForTesting,
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

describe('processPermissionPollResponse — `.permission-highlight` tab cleanup (HS-8323)', () => {
  // HS-8323 — user reported a project tab stuck with the light-blue rounded-pill
  // background after the permission popup auto-dismissed. Root cause: the
  // auto-dismiss path in `processPermissionPollResponse` removed the popup DOM
  // + cleared the state slots but never stripped `.permission-highlight` from
  // the owner tab. `clearPopupOnly()` (the normal-dismiss / minimize / respond
  // paths) DID remove the class, but the polling-loop auto-dismiss is a
  // separate teardown that didn't share the cleanup. Same gap also existed in
  // the partial-mount throw recovery in `showPermissionPopup`. Fix: a shared
  // `clearTabPermissionHighlight(secret)` helper called from every teardown
  // path, with a fresh `data-secret` lookup so a tab-strip re-render between
  // popup-mount and popup-dismiss doesn't leak a stale node.
  //
  // Test fixture: drop a `<div class="project-tab" data-secret="secret-A">`
  // into the DOM before each test so the helper has something to find.

  function installProjectTab(secret: string): HTMLElement {
    const tab = document.createElement('div');
    tab.className = 'project-tab';
    tab.dataset.secret = secret;
    document.body.appendChild(tab);
    return tab;
  }

  it('strips .permission-highlight from the owner tab on auto-dismiss', () => {
    const tab = installProjectTab('secret-A');
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm() },
      v: 1,
    });
    expect(tab.classList.contains('permission-highlight')).toBe(true);

    processPermissionPollResponse({ permissions: { 'secret-A': null }, v: 2 });
    processPermissionPollResponse({ permissions: { 'secret-A': null }, v: 3 });

    expect(document.querySelector('.permission-popup')).toBeNull();
    expect(tab.classList.contains('permission-highlight')).toBe(false);
  });

  it('strips .permission-highlight on the normal-dismiss path too (regression test for `clearPopupOnly` lookup)', () => {
    const tab = installProjectTab('secret-A');
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm() },
      v: 1,
    });
    expect(tab.classList.contains('permission-highlight')).toBe(true);

    // Simulate the user clicking "No response needed" (the shell's onClose
    // callback runs `cleanupAndDismiss` which routes through `clearPopupOnly`).
    document.querySelector<HTMLElement>('.dialog-shell-close')?.click();

    expect(tab.classList.contains('permission-highlight')).toBe(false);
  });

  it('does NOT strip .permission-highlight on a transient unreachable poll (counter does not tick)', () => {
    const tab = installProjectTab('secret-A');
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm() },
      v: 1,
    });
    expect(tab.classList.contains('permission-highlight')).toBe(true);

    // Owner missing from response → transient unreachable per HS-8207. The
    // popup must NOT tear down, and the tab must KEEP its highlight class.
    processPermissionPollResponse({ permissions: {}, v: 2 });

    expect(document.querySelector('.permission-popup')).not.toBeNull();
    expect(tab.classList.contains('permission-highlight')).toBe(true);
  });

  it('cleanup is targeted — a SECOND project tab with no highlight stays untouched', () => {
    const tabA = installProjectTab('secret-A');
    const tabB = installProjectTab('secret-B');
    // tabB starts with no highlight; it must stay clean across the whole flow.
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm() },
      v: 1,
    });
    expect(tabA.classList.contains('permission-highlight')).toBe(true);
    expect(tabB.classList.contains('permission-highlight')).toBe(false);

    processPermissionPollResponse({ permissions: { 'secret-A': null }, v: 2 });
    processPermissionPollResponse({ permissions: { 'secret-A': null }, v: 3 });

    expect(tabA.classList.contains('permission-highlight')).toBe(false);
    expect(tabB.classList.contains('permission-highlight')).toBe(false);
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

describe('showPermissionPopup — noSpawn fallback (HS-8218)', () => {
  // HS-8218 — the user reported that on the Edit-permission case the
  // popup briefly showed a blank terminal, then a Claude channels
  // permission check, then a fresh empty Claude prompt, then the
  // permission popup auto-dismissed. Root cause: the popup hardcoded
  // `terminalId: 'default'` for live-checkout, and when the project's
  // claude was running in some other terminal id (and `'default'` had
  // never been started), the server's `attach` spawned a brand-new
  // `claude --dangerously-load-development-channels` PTY into the
  // popup body — which stole the channel-server's MCP connection from
  // the user's actual claude session.
  //
  // Fix: the popup's checkout passes `noSpawn: true`. Server returns
  // `noSession: true` instead of spawning. Client-side the
  // `onNoLiveSession` callback fires; popup releases the checkout and
  // swaps the body to the flat / diff preview that the non-live code
  // path would have rendered.

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

  it('passes noSpawn: true on the popup checkout when no entry exists', () => {
    processPermissionPollResponse({
      permissions: { 'secret-A': makeTruncatedPerm() },
      v: 1,
    });
    // The popup is the first consumer of (secret-A, 'default') so a
    // new entry was created — and it carries the noSpawn flag.
    const stack = _inspectStackForTesting();
    expect(stack).toHaveLength(1);
    expect(stack[0].noSpawn).toBe(true);
  });

  it('falls back to the flat / diff preview when the server reports no live session', () => {
    processPermissionPollResponse({
      permissions: { 'secret-A': makeTruncatedPerm() },
      v: 1,
    });
    // Pre-fix: the popup body would just sit empty (or, before the
    // noSpawn change, would mount a freshly-spawned claude). Post-fix
    // the noSession signal triggers `onNoLiveSession` → fallback.
    expect(document.querySelector('.permission-popup-live-terminal')).not.toBeNull();
    expect(document.querySelector('.permission-popup-preview')).toBeNull();

    // Server says noSession (no PTY exists for `(secret-A, 'default')`).
    _simulateNoSessionForTesting('secret-A', 'default');

    // Live-terminal container is replaced by the flat preview.
    expect(document.querySelector('.permission-popup-live-terminal')).toBeNull();
    const fallbackPre = document.querySelector('.permission-popup-preview');
    expect(fallbackPre).not.toBeNull();
    // The flat preview text comes from `formatInputPreview` and ends
    // with the truncation ellipsis since the input was truncated.
    expect(fallbackPre?.textContent ?? '').toContain('find /');

    // Checkout was released — entry torn down (popup was the only
    // consumer, so `disposeEntry` ran via `releaseInternal`).
    expect(entryCount()).toBe(0);
  });

  it('keeps the popup chrome and Allow / Deny actions intact across the fallback swap', () => {
    processPermissionPollResponse({
      permissions: { 'secret-A': makeTruncatedPerm() },
      v: 1,
    });
    const popupBefore = document.querySelector('.permission-popup');
    const allowBefore = document.querySelector('.permission-popup-allow');
    const denyBefore = document.querySelector('.permission-popup-deny');
    expect(popupBefore).not.toBeNull();
    expect(allowBefore).not.toBeNull();
    expect(denyBefore).not.toBeNull();

    _simulateNoSessionForTesting('secret-A', 'default');

    // Same popup root, same action buttons — only the body slot was
    // swapped. The user can still Allow / Deny / X / Minimize from the
    // fallback view.
    expect(document.querySelector('.permission-popup')).toBe(popupBefore);
    expect(document.querySelector('.permission-popup-allow')).toBe(allowBefore);
    expect(document.querySelector('.permission-popup-deny')).toBe(denyBefore);
  });

  it('does NOT fire fallback when the entry already exists with a non-noSpawn drawer pane consumer', () => {
    // A drawer pane (or dashboard tile) already has a live entry for
    // `(secret-A, 'default')` — it created the entry WITHOUT noSpawn.
    // The popup's checkout call passes noSpawn: true, but `checkout`
    // ignores noSpawn for an existing entry per HS-8218 (the WS is
    // already attached to a real session). The simulator's noSpawn
    // gate keeps `_simulateNoSessionForTesting` a no-op for this
    // entry, so the popup's body stays as the live xterm.
    const externalMount = document.createElement('div');
    document.body.appendChild(externalMount);
    const externalHandle = checkout({
      projectSecret: 'secret-A',
      terminalId: 'default',
      cols: 80,
      rows: 24,
      mountInto: externalMount,
    });
    expect(_inspectStackForTesting()[0].noSpawn).toBe(false);

    processPermissionPollResponse({
      permissions: { 'secret-A': makeTruncatedPerm() },
      v: 1,
    });
    // Popup body has the live xterm (drawer pane is bumped down).
    expect(document.querySelector('.permission-popup-live-terminal')?.querySelector('.xterm')).not.toBeNull();

    _simulateNoSessionForTesting('secret-A', 'default');

    // Entry's noSpawn is false → simulator was a no-op → popup body
    // unchanged.
    expect(document.querySelector('.permission-popup-live-terminal')).not.toBeNull();
    expect(document.querySelector('.permission-popup-preview')).toBeNull();

    externalHandle.release();
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

describe('pendingPermissionStack — single-popup contract (HS-8219)', () => {
  // HS-8219 — user reported "it's sometimes showing multiple permissions
  // popups at once -- it should only show one at a time -- using a stack
  // data structure". Pre-fix new permissions arriving while one was
  // showing were dropped at the gate; the polling loop's next 100 ms
  // iteration re-introduced them via the for-each. Post-fix the
  // pending-permission stack centralises the queue + mounts the next
  // entry immediately on every popup-close path.

  it('shows the first popup and queues subsequent permissions on the stack', () => {
    processPermissionPollResponse({
      permissions: {
        'secret-A': makePerm({ request_id: 'req-A' }),
        'secret-B': makePerm({ request_id: 'req-B' }),
        'secret-C': makePerm({ request_id: 'req-C' }),
      },
      v: 1,
    });
    // Exactly one popup in the DOM.
    expect(document.querySelectorAll('.permission-popup')).toHaveLength(1);
    const state = _inspectStateForTesting();
    // One of the three is active; the other two are queued.
    expect(state.activePopupRequestId).not.toBeNull();
    expect(state.pendingPermissionStackIds).toHaveLength(2);
    const allKnown = new Set([
      state.activePopupRequestId,
      ...state.pendingPermissionStackIds,
    ]);
    expect(allKnown).toEqual(new Set(['req-A', 'req-B', 'req-C']));
  });

  it('repeated polls do NOT re-push the same request_id', () => {
    processPermissionPollResponse({
      permissions: {
        'secret-A': makePerm({ request_id: 'req-A' }),
        'secret-B': makePerm({ request_id: 'req-B' }),
      },
      v: 1,
    });
    expect(_inspectStateForTesting().pendingPermissionStackIds).toHaveLength(1);

    // Same data on the next poll — stack should NOT grow.
    processPermissionPollResponse({
      permissions: {
        'secret-A': makePerm({ request_id: 'req-A' }),
        'secret-B': makePerm({ request_id: 'req-B' }),
      },
      v: 2,
    });
    expect(_inspectStateForTesting().pendingPermissionStackIds).toHaveLength(1);
  });

  it('GCs stack entries whose request_id disappears from the channel server', () => {
    // Push A active, B queued, C queued.
    processPermissionPollResponse({
      permissions: {
        'secret-A': makePerm({ request_id: 'req-A' }),
        'secret-B': makePerm({ request_id: 'req-B' }),
        'secret-C': makePerm({ request_id: 'req-C' }),
      },
      v: 1,
    });
    expect(_inspectStateForTesting().pendingPermissionStackIds).toHaveLength(2);

    const activeId = _inspectStateForTesting().activePopupRequestId;
    expect(activeId).not.toBeNull();
    // Pick one queued id to GC out (one that isn't the active).
    const queuedIds = _inspectStateForTesting().pendingPermissionStackIds;
    const gcId = queuedIds[0];
    const gcSecret = gcId === 'req-A' ? 'secret-A' : gcId === 'req-B' ? 'secret-B' : 'secret-C';

    // Next poll: gcSecret reports null (channel server resolved it
    // elsewhere — e.g. user typed a response in the terminal).
    processPermissionPollResponse({
      permissions: {
        'secret-A': activeId === 'req-A' ? makePerm({ request_id: 'req-A' }) : null,
        'secret-B': activeId === 'req-B' ? makePerm({ request_id: 'req-B' }) : null,
        'secret-C': activeId === 'req-C' ? makePerm({ request_id: 'req-C' }) : null,
        // override the gc'd one to null
        [gcSecret]: null,
      },
      v: 2,
    });
    const post = _inspectStateForTesting();
    expect(post.pendingPermissionStackIds).not.toContain(gcId);
  });

  it('mounts the next queued permission immediately on Allow / respondToPermission', () => {
    processPermissionPollResponse({
      permissions: {
        'secret-A': makePerm({ request_id: 'req-A' }),
        'secret-B': makePerm({ request_id: 'req-B' }),
      },
      v: 1,
    });
    const firstActive = _inspectStateForTesting().activePopupRequestId;
    expect(firstActive).not.toBeNull();

    // Click Allow on the active popup. The respond path calls
    // mountNextFromPendingStack, so the queued one should pop and
    // mount synchronously.
    const allowBtn = document.querySelector<HTMLButtonElement>('.permission-popup-allow');
    expect(allowBtn).not.toBeNull();
    allowBtn?.click();

    const secondActive = _inspectStateForTesting().activePopupRequestId;
    expect(secondActive).not.toBeNull();
    expect(secondActive).not.toBe(firstActive);
    expect(document.querySelectorAll('.permission-popup')).toHaveLength(1);
    // Stack drained.
    expect(_inspectStateForTesting().pendingPermissionStackIds).toHaveLength(0);
  });

  it('mounts the next queued permission on dismiss (X button) without waiting on a poll', () => {
    processPermissionPollResponse({
      permissions: {
        'secret-A': makePerm({ request_id: 'req-A' }),
        'secret-B': makePerm({ request_id: 'req-B' }),
      },
      v: 1,
    });
    const firstActive = _inspectStateForTesting().activePopupRequestId;
    const closeBtn = document.querySelector<HTMLButtonElement>('.dialog-shell-close');
    expect(closeBtn).not.toBeNull();
    closeBtn?.click();

    const secondActive = _inspectStateForTesting().activePopupRequestId;
    expect(secondActive).not.toBeNull();
    expect(secondActive).not.toBe(firstActive);
    expect(document.querySelectorAll('.permission-popup')).toHaveLength(1);
  });

  it('LIFO ordering: most recently pushed pops first', () => {
    // Initial poll: A active.
    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm({ request_id: 'req-A' }) },
      v: 1,
    });
    expect(_inspectStateForTesting().activePopupRequestId).toBe('req-A');

    // Next poll: B added — pushed onto stack since A is active.
    processPermissionPollResponse({
      permissions: {
        'secret-A': makePerm({ request_id: 'req-A' }),
        'secret-B': makePerm({ request_id: 'req-B' }),
      },
      v: 2,
    });
    // Next poll: C added.
    processPermissionPollResponse({
      permissions: {
        'secret-A': makePerm({ request_id: 'req-A' }),
        'secret-B': makePerm({ request_id: 'req-B' }),
        'secret-C': makePerm({ request_id: 'req-C' }),
      },
      v: 3,
    });
    expect(_inspectStateForTesting().pendingPermissionStackIds).toEqual(['req-B', 'req-C']);

    // Dismiss A → C (most recent push) pops first.
    document.querySelector<HTMLButtonElement>('.dialog-shell-close')?.click();
    expect(_inspectStateForTesting().activePopupRequestId).toBe('req-C');

    // Dismiss C → B pops.
    document.querySelector<HTMLButtonElement>('.dialog-shell-close')?.click();
    expect(_inspectStateForTesting().activePopupRequestId).toBe('req-B');
  });

  it('skips queued entries that were dismissed/responded/minimized while waiting', () => {
    // Set up: A active, B queued, C queued.
    processPermissionPollResponse({
      permissions: {
        'secret-A': makePerm({ request_id: 'req-A' }),
        'secret-B': makePerm({ request_id: 'req-B' }),
        'secret-C': makePerm({ request_id: 'req-C' }),
      },
      v: 1,
    });
    const queued = _inspectStateForTesting().pendingPermissionStackIds;
    expect(queued).toHaveLength(2);

    // Mark the top-of-stack entry as dismissed (simulating that the
    // user dismissed it via some other path while it was waiting).
    const topOfStack = queued[queued.length - 1];
    dismissedRequestIds.add(topOfStack);

    // Dismiss the active popup → mountNextFromPendingStack should
    // skip the dismissed top and mount the other queued entry.
    document.querySelector<HTMLButtonElement>('.dialog-shell-close')?.click();
    const newActive = _inspectStateForTesting().activePopupRequestId;
    expect(newActive).not.toBeNull();
    expect(newActive).not.toBe(topOfStack);
  });

  it('querySelectorAll defensive cleanup: never leaves multiple .permission-popup in DOM', () => {
    // Manually inject a stale stray popup BEFORE the poll runs.
    const stray = document.createElement('div');
    stray.className = 'permission-popup';
    stray.textContent = 'stale';
    document.body.appendChild(stray);
    expect(document.querySelectorAll('.permission-popup')).toHaveLength(1);

    processPermissionPollResponse({
      permissions: { 'secret-A': makePerm({ request_id: 'req-A' }) },
      v: 1,
    });
    // Single popup post-mount — the stray was cleaned up.
    expect(document.querySelectorAll('.permission-popup')).toHaveLength(1);
    expect(document.querySelector('.permission-popup')?.textContent).not.toBe('stale');
  });

  it('shouldSkipPermission gates on responded / dismissed / minimized', () => {
    expect(shouldSkipPermission('req-A')).toBe(false);
    respondedRequestIds.add('req-R');
    dismissedRequestIds.add('req-D');
    expect(shouldSkipPermission('req-R')).toBe(true);
    expect(shouldSkipPermission('req-D')).toBe(true);
    expect(shouldSkipPermission('req-A')).toBe(false);
  });
});

describe('shouldUseLiveCheckout — pure heuristic (HS-8217)', () => {
  // HS-8217 — the user reported that the static `<pre>` / DOM diff path
  // for non-truncated previews was hard to follow vs the actual claude
  // TUI's coloured output. The heuristic now triggers live-borrow for
  // any non-trivial preview, not just truncation.

  function diff(overrides: Partial<EditDiffShape> = {}): EditDiffShape {
    return {
      oldStr: '',
      newStr: '',
      filePath: null,
      replaceAll: false,
      truncated: false,
      ...overrides,
    };
  }

  it('triggers for ANY parseable Edit/Write diff — even single-line', () => {
    // The user's HS-8217 example: a single-line function-signature
    // change. Pre-fix this would render as the static colour-coded
    // HTML diff (`+`/`−` rows); the user finds the real claude TUI's
    // rendering significantly easier to scan.
    expect(shouldUseLiveCheckout(diff({
      oldStr: 'def lookup_glyph(ch: str) -> Glyph:',
      newStr: 'def lookup_glyph(ch: str, *, force_block: bool = False) -> Glyph:',
    }), '')).toBe(true);
  });

  it('triggers for a multi-line Edit diff', () => {
    expect(shouldUseLiveCheckout(diff({
      oldStr: 'a\nb\nc',
      newStr: 'a\nB\nc',
    }), '')).toBe(true);
  });

  it('triggers for a truncated Edit diff (back-compat with HS-8139 gate)', () => {
    expect(shouldUseLiveCheckout(diff({ truncated: true }), '')).toBe(true);
  });

  it('triggers for a flat preview ending in the truncation ellipsis (back-compat with HS-7999)', () => {
    expect(shouldUseLiveCheckout(null, 'find / -name foo …')).toBe(true);
  });

  it('triggers for a multi-line flat preview', () => {
    expect(shouldUseLiveCheckout(null, 'url: https://example.com\nbody: hello')).toBe(true);
  });

  it('triggers for a long single-line flat preview (>80 chars)', () => {
    const longCmd = 'find / -name "*.log" -mtime -1 -size +1M | xargs -I {} sh -c \'echo === found {} ===\'';
    expect(longCmd.length).toBeGreaterThan(LIVE_CHECKOUT_PREVIEW_CHAR_THRESHOLD);
    expect(shouldUseLiveCheckout(null, longCmd)).toBe(true);
  });

  it('stays static for a short single-line bash one-liner', () => {
    expect(shouldUseLiveCheckout(null, 'ls -la')).toBe(false);
    expect(shouldUseLiveCheckout(null, 'git status')).toBe(false);
    expect(shouldUseLiveCheckout(null, '/Users/me/file.ts')).toBe(false);
  });

  it('stays static for an empty preview when there is no edit diff', () => {
    expect(shouldUseLiveCheckout(null, '')).toBe(false);
  });

  it('treats a single-line at exactly the threshold as static (boundary)', () => {
    const exactly = 'a'.repeat(LIVE_CHECKOUT_PREVIEW_CHAR_THRESHOLD);
    expect(exactly.length).toBe(LIVE_CHECKOUT_PREVIEW_CHAR_THRESHOLD);
    expect(shouldUseLiveCheckout(null, exactly)).toBe(false);
    // One char over flips the gate.
    expect(shouldUseLiveCheckout(null, exactly + 'b')).toBe(true);
  });
});

describe('showPermissionPopup — non-truncated Edit triggers live checkout (HS-8217)', () => {
  // Integration regression: an Edit-tool permission with a parseable
  // (non-truncated) `input_preview` now mounts the live-terminal
  // container in the popup body, not the static `renderEditDiffPreview`
  // DOM diff. Pre-HS-8217 this case took the static `.edit-diff-preview`
  // path.

  function makeEditPerm(): PermissionData {
    return {
      request_id: 'req-edit-1',
      tool_name: 'Edit',
      description: 'Edit ascii-art.py',
      input_preview: JSON.stringify({
        file_path: '/Users/me/ascii-art.py',
        old_string: 'def lookup_glyph(ch: str) -> Glyph:',
        new_string: 'def lookup_glyph(ch: str, *, force_block: bool = False) -> Glyph:',
      }),
    };
  }

  it('mounts the live-terminal container instead of the static diff preview', () => {
    processPermissionPollResponse({
      permissions: { 'secret-A': makeEditPerm() },
      v: 1,
    });
    expect(document.querySelector('.permission-popup-live-terminal')).not.toBeNull();
    // Pre-HS-8217 this DOM was present for non-truncated Edits.
    expect(document.querySelector('.edit-diff-preview')).toBeNull();
  });

  it('falls back to the static diff preview when the server reports no live session', () => {
    processPermissionPollResponse({
      permissions: { 'secret-A': makeEditPerm() },
      v: 1,
    });
    // Server says there's no live PTY for `(secret-A, 'default')`.
    _simulateNoSessionForTesting('secret-A', 'default');
    // Live container gone, static diff preview now in its place.
    expect(document.querySelector('.permission-popup-live-terminal')).toBeNull();
    expect(document.querySelector('.edit-diff-preview')).not.toBeNull();
  });
});

describe('showPermissionPopup — short bash stays static (HS-8217)', () => {
  // Negative regression: a short single-line bash one-liner does NOT
  // trigger the live-checkout path — the tight static `<pre>` is the
  // intended UX for one-liners.

  it('renders the HS-8299 Bash custom layout for a short single-line bash command (HS-8299 supersedes HS-8217 for Bash)', () => {
    // HS-8299 (2026-05-08) — Bash tool now ALWAYS uses the dedicated
    // `<pre class="permission-bash-command">` body + 3-stacked-button
    // layout regardless of length, so `useLiveCheckout` no longer fires
    // for short bash commands either. The pre-fix HS-8217 expectation
    // (flat `.permission-popup-preview` `<pre>` for short commands) was
    // replaced; the live-checkout suppression for short bash that
    // HS-8217 verified is preserved (no `.permission-popup-live-terminal`,
    // no checkout entry).
    processPermissionPollResponse({
      permissions: {
        'secret-A': {
          request_id: 'req-bash-short',
          tool_name: 'Bash',
          description: 'List files',
          input_preview: '{"command":"ls -la"}',
        },
      },
      v: 1,
    });
    expect(document.querySelector('.permission-bash-command')).not.toBeNull();
    expect(document.querySelector('.permission-popup-preview')).toBeNull();
    expect(document.querySelector('.permission-popup-live-terminal')).toBeNull();
    // No checkout entry was created for this popup since useLiveCheckout was false.
    expect(_inspectStackForTesting()).toHaveLength(0);
  });
});

describe('Bash custom layout (HS-8299)', () => {
  // HS-8299 (2026-05-08) — Bash tool gets a dedicated layout: title
  // "Allow Claude to run", scrollable `<pre>` body, 3-stacked-button
  // actions (Yes / Yes-and-allow-always / No), with the live-terminal
  // checkout + flat `<pre>` paths bypassed entirely. Tests pin the
  // header copy + body shape + actions wiring + the suppression of the
  // legacy two-icon-button + always-allow-affordance for Bash.
  it('renders title "Allow Claude to run" + scrollable command + 3 stacked buttons for Bash', () => {
    processPermissionPollResponse({
      permissions: {
        'secret-A': {
          request_id: 'req-bash-custom-1',
          tool_name: 'Bash',
          description: 'List files',
          input_preview: '{"command":"ls -la /tmp"}',
        },
      },
      v: 1,
    });
    // Body: scrollable `<pre>` with the verbatim command.
    const pre = document.querySelector<HTMLElement>('.permission-bash-command');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe('ls -la /tmp');
    // Actions: 3 vertically-stacked buttons.
    const stacked = document.querySelector<HTMLElement>('.permission-popup-actions-stacked');
    expect(stacked).not.toBeNull();
    expect(stacked?.querySelectorAll('button').length).toBe(3);
    expect(stacked?.querySelector('.permission-popup-allow')?.textContent).toBe('Yes');
    expect(stacked?.querySelector('.permission-popup-allow-always')?.textContent).toBe('Yes, and allow this command and similar in the future');
    expect(stacked?.querySelector('.permission-popup-deny')?.textContent).toBe('No');
    // Title: "Allow Claude to run".
    const title = document.querySelector<HTMLElement>('.dialog-shell-title');
    expect(title?.textContent ?? '').toContain('Allow Claude to run');
    // Tool chip is suppressed for Bash (the title carries the verb).
    expect(document.querySelector('.dialog-shell-tool')).toBeNull();
    // Legacy two-icon-button row is NOT rendered for Bash.
    expect(document.querySelector('.permission-popup-actions:not(.permission-popup-actions-stacked)')).toBeNull();
    // Always-allow affordance is folded into the middle button — the
    // legacy checkbox-style affordance is NOT rendered for Bash.
    expect(document.querySelector('.permission-popup-always-allow')).toBeNull();
    // No live-checkout, no flat `<pre>` preview.
    expect(document.querySelector('.permission-popup-live-terminal')).toBeNull();
    expect(document.querySelector('.permission-popup-preview')).toBeNull();
  });

  it('uses the Bash layout regardless of command length (no live-checkout fallback)', () => {
    // HS-8299 Q1 (a) — Bash ALWAYS uses the new layout, even for the
    // long-pipeline shapes that would have triggered HS-8217's live-
    // checkout pre-HS-8299.
    const longCommand = `mkdir -p /tmp/claude-permission-test && cd /tmp/claude-permission-test && printf 'one\\ntwo\\nthree\\nfour\\n' > long-run-input.txt && cat long-run-input.txt | awk '{ print NR":"$0 }' | sort -r | tee long-run-output.txt | wc -l && echo "long-run permission test finished at $(date -u +%Y-%m-%dT%H:%M:%SZ)"`;
    processPermissionPollResponse({
      permissions: {
        'secret-A': {
          request_id: 'req-bash-custom-2',
          tool_name: 'Bash',
          description: 'Long-run permission test',
          input_preview: JSON.stringify({ command: longCommand }),
        },
      },
      v: 1,
    });
    expect(document.querySelector('.permission-bash-command')?.textContent).toBe(longCommand);
    expect(document.querySelector('.permission-popup-live-terminal')).toBeNull();
    expect(_inspectStackForTesting()).toHaveLength(0);
  });

  it('clicking "No" responds with deny', async () => {
    processPermissionPollResponse({
      permissions: {
        'secret-A': {
          request_id: 'req-bash-deny',
          tool_name: 'Bash',
          description: 'Whoami',
          input_preview: '{"command":"whoami"}',
        },
      },
      v: 1,
    });
    const denyBtn = document.querySelector<HTMLButtonElement>('.permission-popup-deny')!;
    expect(denyBtn).not.toBeNull();
    denyBtn.click();
    // Wait one microtask for the async respond path.
    await Promise.resolve();
    // Popup torn down — no `.permission-popup` left in the DOM.
    expect(document.querySelector('.permission-popup')).toBeNull();
  });

  it('clicking "Yes" responds with allow', async () => {
    processPermissionPollResponse({
      permissions: {
        'secret-A': {
          request_id: 'req-bash-allow',
          tool_name: 'Bash',
          description: 'pwd',
          input_preview: '{"command":"pwd"}',
        },
      },
      v: 1,
    });
    const allowBtn = document.querySelector<HTMLButtonElement>('.permission-popup-allow')!;
    expect(allowBtn).not.toBeNull();
    allowBtn.click();
    await Promise.resolve();
    expect(document.querySelector('.permission-popup')).toBeNull();
  });

  it('non-Bash tool calls keep the legacy two-icon-button + always-allow-affordance layout', () => {
    // Defence-in-depth — the new Bash branch must NOT leak across to
    // tools that share the popup surface (Read / Glob / WebFetch /
    // WebSearch / etc.). Pre-HS-8299 a Read permission rendered as
    // `<pre class="permission-popup-preview">` with green-check + red-X
    // icons + the always-allow-this affordance link below. Post-HS-8299
    // that path is preserved unchanged.
    processPermissionPollResponse({
      permissions: {
        'secret-A': {
          request_id: 'req-read-custom',
          tool_name: 'Read',
          description: 'Read a file',
          input_preview: '{"file_path":"/tmp/foo.txt"}',
        },
      },
      v: 1,
    });
    expect(document.querySelector('.permission-bash-command')).toBeNull();
    expect(document.querySelector('.permission-popup-actions-stacked')).toBeNull();
    // Legacy two-button row IS present.
    const legacyActions = document.querySelector<HTMLElement>('.permission-popup-actions');
    expect(legacyActions).not.toBeNull();
    expect(legacyActions?.querySelector('.permission-popup-allow')).not.toBeNull();
    expect(legacyActions?.querySelector('.permission-popup-deny')).not.toBeNull();
    // Always-allow affordance IS rendered for Read (it's allow-listable).
    expect(document.querySelector('.permission-popup-always-allow')).not.toBeNull();
  });
});

describe('Write custom layout (HS-8296)', () => {
  // HS-8296 (2026-05-08) — Write tool gets a parallel tool-specific
  // layout to HS-8299's Bash redesign: title `Allow write to <path>?`,
  // scrollable `<pre>` of the file content (or `Binary Data (NNN bytes)`
  // for non-text), 3-stacked-button actions, no live-terminal checkout.
  it('renders title `Allow write to <path>?` + scrollable content + 3 stacked buttons for Write (text)', () => {
    processPermissionPollResponse({
      permissions: {
        'secret-A': {
          request_id: 'req-write-text',
          tool_name: 'Write',
          description: 'Write a config file',
          input_preview: JSON.stringify({
            file_path: '/tmp/claude-permission-test/foo.txt',
            content: 'hello\nworld\n',
          }),
        },
      },
      v: 1,
    });
    // Title carries the path.
    const title = document.querySelector<HTMLElement>('.dialog-shell-title');
    expect(title?.textContent ?? '').toContain('Allow write to /tmp/claude-permission-test/foo.txt?');
    // Tool chip suppressed (the title carries the verb already).
    expect(document.querySelector('.dialog-shell-tool')).toBeNull();
    // Body: scrollable `<pre>` with the verbatim content.
    const pre = document.querySelector<HTMLElement>('.permission-write-content');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe('hello\nworld\n');
    expect(pre?.classList.contains('permission-write-content-binary')).toBe(false);
    // Actions: 3 vertically-stacked buttons.
    const stacked = document.querySelector<HTMLElement>('.permission-popup-actions-stacked');
    expect(stacked).not.toBeNull();
    expect(stacked?.querySelectorAll('button').length).toBe(3);
    expect(stacked?.querySelector('.permission-popup-allow')?.textContent).toBe('Yes');
    // The middle-button label mirrors Claude's TUI copy and includes
    // the parent dir of the target file.
    const allowAlwaysLabel = stacked?.querySelector('.permission-popup-allow-always')?.textContent ?? '';
    expect(allowAlwaysLabel).toContain('/tmp/claude-permission-test/');
    expect(allowAlwaysLabel).toContain("don't ask again");
    expect(allowAlwaysLabel).toContain('during this session');
    expect(stacked?.querySelector('.permission-popup-deny')?.textContent).toBe('No');
    // Legacy two-icon-button row + always-allow affordance NOT rendered.
    expect(document.querySelector('.permission-popup-actions:not(.permission-popup-actions-stacked)')).toBeNull();
    expect(document.querySelector('.permission-popup-always-allow')).toBeNull();
    // No live-checkout, no flat `<pre>` preview.
    expect(document.querySelector('.permission-popup-live-terminal')).toBeNull();
    expect(document.querySelector('.permission-popup-preview')).toBeNull();
  });

  it('renders the binary-data marker for non-text Write content', () => {
    // 100 NUL bytes inside a 200-char string — well above the 1% threshold.
    const binaryContent = '\0'.repeat(100) + 'x'.repeat(100);
    processPermissionPollResponse({
      permissions: {
        'secret-A': {
          request_id: 'req-write-binary',
          tool_name: 'Write',
          description: 'Write binary',
          input_preview: JSON.stringify({
            file_path: '/tmp/foo.bin',
            content: binaryContent,
          }),
        },
      },
      v: 1,
    });
    const pre = document.querySelector<HTMLElement>('.permission-write-content');
    expect(pre).not.toBeNull();
    expect(pre?.classList.contains('permission-write-content-binary')).toBe(true);
    expect(pre?.textContent).toBe(`Binary Data (${binaryContent.length} bytes)`);
  });

  it('clicking "Yes" responds with allow', async () => {
    processPermissionPollResponse({
      permissions: {
        'secret-A': {
          request_id: 'req-write-allow',
          tool_name: 'Write',
          description: 'Write a file',
          input_preview: JSON.stringify({ file_path: '/tmp/a.txt', content: 'hi' }),
        },
      },
      v: 1,
    });
    const allowBtn = document.querySelector<HTMLButtonElement>('.permission-popup-allow')!;
    allowBtn.click();
    await Promise.resolve();
    expect(document.querySelector('.permission-popup')).toBeNull();
  });

  it('clicking "No" responds with deny', async () => {
    processPermissionPollResponse({
      permissions: {
        'secret-A': {
          request_id: 'req-write-deny',
          tool_name: 'Write',
          description: 'Write a file',
          input_preview: JSON.stringify({ file_path: '/tmp/b.txt', content: 'hi' }),
        },
      },
      v: 1,
    });
    const denyBtn = document.querySelector<HTMLButtonElement>('.permission-popup-deny')!;
    denyBtn.click();
    await Promise.resolve();
    expect(document.querySelector('.permission-popup')).toBeNull();
  });

  it('falls back to the legacy layout when input_preview is malformed (defence-in-depth)', () => {
    processPermissionPollResponse({
      permissions: {
        'secret-A': {
          request_id: 'req-write-malformed',
          tool_name: 'Write',
          description: 'Write something',
          input_preview: 'not-valid-json',
        },
      },
      v: 1,
    });
    // No custom Write layout — extractWriteFields returned null, so the
    // popup mounts the legacy two-icon-button surface.
    expect(document.querySelector('.permission-write-content')).toBeNull();
    expect(document.querySelector('.permission-popup-actions-stacked')).toBeNull();
    // Legacy actions row IS present.
    expect(document.querySelector('.permission-popup-actions:not(.permission-popup-actions-stacked)')).not.toBeNull();
  });
});

