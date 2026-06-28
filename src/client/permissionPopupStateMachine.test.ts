// @vitest-environment happy-dom
/**
 * HS-9129 — unit coverage for the permission popup state machine's exported
 * helpers + orchestration paths that `permissionOverlay.test.ts` doesn't reach
 * (it focuses on `processPermissionPollResponse`). Here we drive the machine
 * directly with a mock `mountPopupBody` hook and the real `channelStore` +
 * `permissionPopupState`, mocking only the external-effect deps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { channelStore } from './channelStore.js';
import type { PermissionData } from './permissionOverlayHelpers.js';
import {
  dismissedRequestIds,
  freshPermissionOverlayState,
  type MinimizedRecord,
  minimizedRequests,
  permissionState,
  respondedRequestIds,
  setPermissionState,
} from './permissionPopupState.js';
import {
  clearTabPermissionHighlight,
  getMinimizedPermissionSecrets,
  getQueuedPermissionRequestIds,
  initPermissionPopupStateMachine,
  mountNextFromPendingStack,
  reopenMinimizedForSecret,
  shouldSkipPermission,
  showPermissionPopup,
  startPermissionPolling,
  stopPermissionPolling,
  syncMinimizedDots,
} from './permissionPopupStateMachine.js';

const pollMock = vi.fn<(v: number) => Promise<{ permissions: Record<string, PermissionData | null>; v: number }>>();
vi.mock('../api/index.js', () => ({ pollProjectPermissions: (v: number) => pollMock(v) }));
const releaseMock = vi.fn();
vi.mock('./permissionLiveCheckout.js', () => ({ releaseActiveCheckoutIfAny: (): void => { releaseMock(); } }));
vi.mock('./channelUI.js', () => ({
  clearProjectAttention: vi.fn(),
  getProjectAttentionSecrets: vi.fn(() => new Set<string>()),
  markProjectAttention: vi.fn(),
}));
vi.mock('./projectTabs.js', () => ({ updateStatusDots: vi.fn() }));

function perm(over: Partial<PermissionData> = {}): PermissionData {
  return { request_id: 'req-1', tool_name: 'Bash', description: 'd', ...over };
}

function resetAll(): void {
  respondedRequestIds.clear();
  dismissedRequestIds.clear();
  for (const rec of minimizedRequests.values()) clearTimeout(rec.timeoutId);
  minimizedRequests.clear();
  channelStore.actions.retainPendingPermissions(new Set<string>());
  channelStore.actions.setMinimizedSecrets(new Set<string>());
  setPermissionState(freshPermissionOverlayState());
}

beforeEach(() => { document.body.innerHTML = ''; resetAll(); pollMock.mockReset(); releaseMock.mockReset(); });
afterEach(() => { resetAll(); vi.useRealTimers(); });

// NOTE: this test runs FIRST so the singleton `hooks` is still null (there's no
// reset-hooks export; every later test installs its own hook via init()).
describe('init guard', () => {
  it('showPermissionPopup throws a clear error before the mount hook is installed', () => {
    expect(() => showPermissionPopup('s', perm())).toThrow(/initPermissionPopupStateMachine must be called/);
    // state must not be stranded non-null after the throw
    expect(permissionState.activePopupRequestId).toBeNull();
  });
});

function installHook(fn: (secret: string, p: PermissionData) => void = () => {}): ReturnType<typeof vi.fn> {
  const hook = vi.fn(fn);
  initPermissionPopupStateMachine({ mountPopupBody: hook });
  return hook;
}

describe('clearTabPermissionHighlight', () => {
  it('is a no-op for a null secret', () => { expect(() => clearTabPermissionHighlight(null)).not.toThrow(); });
  it('removes the highlight class from the matching project tab', () => {
    document.body.innerHTML = '<div class="project-tab permission-highlight" data-secret="abc"></div>';
    clearTabPermissionHighlight('abc');
    expect(document.querySelector('.project-tab')!.classList.contains('permission-highlight')).toBe(false);
  });
  it('is a no-op when no tab matches the secret', () => { expect(() => clearTabPermissionHighlight('missing')).not.toThrow(); });
});

describe('dedup queries', () => {
  it('shouldSkipPermission is true for responded / dismissed / minimized ids, false otherwise', () => {
    respondedRequestIds.add('r');
    dismissedRequestIds.add('d');
    minimizedRequests.set('m', { secret: 's', perm: perm({ request_id: 'm' }), timeoutId: setTimeout(() => {}, 0) });
    expect(shouldSkipPermission('r')).toBe(true);
    expect(shouldSkipPermission('d')).toBe(true);
    expect(shouldSkipPermission('m')).toBe(true);
    expect(shouldSkipPermission('unknown')).toBe(false);
  });
  it('getMinimizedPermissionSecrets projects the minimized map to its secrets', () => {
    minimizedRequests.set('a', { secret: 's1', perm: perm({ request_id: 'a' }), timeoutId: setTimeout(() => {}, 0) });
    minimizedRequests.set('b', { secret: 's2', perm: perm({ request_id: 'b' }), timeoutId: setTimeout(() => {}, 0) });
    expect(getMinimizedPermissionSecrets()).toEqual(new Set(['s1', 's2']));
  });
  it('getQueuedPermissionRequestIds reflects the pending stack', () => {
    installHook();
    permissionState.activePopupRequestId = 'active'; // force the queue path
    showPermissionPopup('s', perm({ request_id: 'q1' }));
    showPermissionPopup('s', perm({ request_id: 'q2' }));
    expect(getQueuedPermissionRequestIds()).toEqual(['q1', 'q2']);
  });
});

describe('showPermissionPopup', () => {
  it('mounts when idle and records the active request + owner secret', () => {
    const hook = installHook();
    showPermissionPopup('owner', perm({ request_id: 'x' }));
    expect(hook).toHaveBeenCalledWith('owner', expect.objectContaining({ request_id: 'x' }));
    expect(permissionState.activePopupRequestId).toBe('x');
    expect(permissionState.activePopupOwnerSecret).toBe('owner');
  });
  it('is a no-op when the same request is already active', () => {
    const hook = installHook();
    showPermissionPopup('owner', perm({ request_id: 'x' }));
    hook.mockClear();
    showPermissionPopup('owner', perm({ request_id: 'x' }));
    expect(hook).not.toHaveBeenCalled();
  });
  it('skips a responded request', () => {
    const hook = installHook();
    respondedRequestIds.add('done');
    showPermissionPopup('owner', perm({ request_id: 'done' }));
    expect(hook).not.toHaveBeenCalled();
    expect(permissionState.activePopupRequestId).toBeNull();
  });
  it('queues onto the pending stack when another popup is active; ignores a duplicate queue', () => {
    const hook = installHook();
    showPermissionPopup('owner', perm({ request_id: 'first' }));
    hook.mockClear();
    showPermissionPopup('owner', perm({ request_id: 'second' }));
    expect(hook).not.toHaveBeenCalled();
    expect(getQueuedPermissionRequestIds()).toEqual(['second']);
    showPermissionPopup('owner', perm({ request_id: 'second' })); // duplicate — no-op
    expect(getQueuedPermissionRequestIds()).toEqual(['second']);
  });
  it('recovers from a partial-mount throw: clears state, releases checkout, rethrows', () => {
    installHook(() => { throw new Error('mount blew up'); });
    expect(() => showPermissionPopup('owner', perm({ request_id: 'boom' }))).toThrow('mount blew up');
    expect(permissionState.activePopupRequestId).toBeNull();
    expect(permissionState.activePopupOwnerSecret).toBeNull();
    expect(releaseMock).toHaveBeenCalled();
  });
});

describe('mountNextFromPendingStack', () => {
  it('is a no-op when the stack is empty', () => {
    installHook();
    expect(() => mountNextFromPendingStack()).not.toThrow();
  });
  it('drains stale (already-handled) entries and mounts the next valid one', () => {
    const hook = installHook();
    // Two queued behind an active popup.
    showPermissionPopup('owner', perm({ request_id: 'active' }));
    showPermissionPopup('owner', perm({ request_id: 'stale' }));
    showPermissionPopup('owner', perm({ request_id: 'valid' }));
    // The stale one gets handled elsewhere; clear the active slot so the next mount isn't gated.
    respondedRequestIds.add('stale');
    permissionState.activePopupRequestId = null;
    permissionState.activePopupOwnerSecret = null;
    hook.mockClear();
    mountNextFromPendingStack();
    // 'valid' is the top (pushed last); 'stale' below it is skipped if reached.
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith('owner', expect.objectContaining({ request_id: 'valid' }));
  });
});

describe('reopenMinimizedForSecret', () => {
  it('re-opens a minimized popup for the secret, clears the record, returns true', () => {
    const hook = installHook();
    const rec: MinimizedRecord = { secret: 's9', perm: perm({ request_id: 'min' }), timeoutId: setTimeout(() => {}, 10_000) };
    minimizedRequests.set('min', rec);
    const ok = reopenMinimizedForSecret('s9');
    expect(ok).toBe(true);
    expect(minimizedRequests.has('min')).toBe(false);
    expect(hook).toHaveBeenCalledWith('s9', expect.objectContaining({ request_id: 'min' }));
  });
  it('returns false when no minimized popup matches the secret', () => {
    installHook();
    expect(reopenMinimizedForSecret('nope')).toBe(false);
  });
});

describe('syncMinimizedDots', () => {
  it('mirrors the minimized map secrets into the channel store', () => {
    installHook();
    minimizedRequests.set('a', { secret: 'sa', perm: perm({ request_id: 'a' }), timeoutId: setTimeout(() => {}, 0) });
    syncMinimizedDots();
    expect(channelStore.state.value.minimizedSecrets).toEqual(new Set(['sa']));
  });
});

describe('startPermissionPolling / stopPermissionPolling', () => {
  it('polls, applies the version, then stops cleanly (and a second start is a no-op)', async () => {
    vi.useFakeTimers();
    installHook();
    pollMock.mockResolvedValue({ permissions: {}, v: 42 });
    startPermissionPolling(null, vi.fn());
    startPermissionPolling(null, vi.fn()); // already active → no-op
    await vi.advanceTimersByTimeAsync(5);
    expect(pollMock).toHaveBeenCalled();
    expect(permissionState.permissionVersion).toBe(42);
    stopPermissionPolling();
    await vi.advanceTimersByTimeAsync(200); // let the rescheduled poll fire + no-op
    pollMock.mockClear();
    await vi.advanceTimersByTimeAsync(500);
    expect(pollMock).not.toHaveBeenCalled(); // confirmed stopped
  });

  it('retries after a poll rejection without crashing the loop', async () => {
    vi.useFakeTimers();
    installHook();
    pollMock.mockRejectedValueOnce(new Error('network blip')).mockResolvedValue({ permissions: {}, v: 9 });
    startPermissionPolling(null, vi.fn());
    // First poll rejects → catch awaits POLL_RETRY_MS (5000) → reschedules +100ms.
    await vi.advanceTimersByTimeAsync(5300);
    expect(pollMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(permissionState.permissionVersion).toBe(9);
    stopPermissionPolling();
    await vi.advanceTimersByTimeAsync(200);
  });
});
