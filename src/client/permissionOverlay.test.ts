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
import { _resetForTesting as resetCheckout } from './terminalCheckout.js';

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
