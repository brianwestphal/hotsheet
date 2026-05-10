// @vitest-environment happy-dom
/**
 * §61 Phase 3d / HS-8320 — unit tests for `channelStore`. The store
 * consolidates the Claude channel + permission-overlay reactive state
 * spread across `channelUI.tsx` (11 module-level lets/maps) and
 * `permissionOverlay.tsx` (pending stack + minimized projection).
 * These tests pin the action contract in isolation; integration with
 * `setChannelBusy()` / `setChannelAlive()` / `isChannelBusy()` /
 * `isChannelAlive()` is covered by `channelUI.test.ts`, and the
 * pending-permission queue + minimized projection semantics are
 * exercised by `permissionOverlay.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _channelStoreForTesting, channelStore, type PendingPermission } from './channelStore.js';
import type { PermissionData } from './permissionOverlay.js';

beforeEach(() => {
  _channelStoreForTesting.reset();
});

afterEach(() => {
  _channelStoreForTesting.reset();
});

function perm(requestId: string, tool = 'Bash'): PermissionData {
  return { request_id: requestId, tool_name: tool, description: `desc ${requestId}` };
}

function entry(secret: string, requestId: string): PendingPermission {
  return { secret, perm: perm(requestId) };
}

describe('channelStore — initial state', () => {
  it('starts with all-false / empty defaults', () => {
    expect(channelStore.state.value).toEqual({
      alive: false,
      busy: false,
      shellBusy: false,
      busySecrets: new Set(),
      channelAutoMode: false,
      autoModeByProject: new Map(),
      channelAutoBackoff: 0,
      mostRecentSpinnerAtMs: null,
      pendingPermissions: [],
      minimizedSecrets: new Set(),
    });
  });

  it('reset() returns to initial after mutations', () => {
    channelStore.actions.setAlive(true);
    channelStore.actions.setBusy(true);
    channelStore.actions.markBusySecret('sec-a');
    channelStore.actions.setChannelAutoMode(true);
    channelStore.actions.setAutoModeForProject('sec-a', true);
    channelStore.actions.setChannelAutoBackoff(3);
    channelStore.actions.setMostRecentSpinnerAt(123_456);
    channelStore.actions.pushPendingPermission(entry('sec-a', 'r1'));
    channelStore.actions.setMinimizedSecrets(new Set(['sec-a']));
    _channelStoreForTesting.reset();
    expect(channelStore.state.value.alive).toBe(false);
    expect(channelStore.state.value.busy).toBe(false);
    expect(channelStore.state.value.busySecrets.size).toBe(0);
    expect(channelStore.state.value.channelAutoMode).toBe(false);
    expect(channelStore.state.value.autoModeByProject.size).toBe(0);
    expect(channelStore.state.value.channelAutoBackoff).toBe(0);
    expect(channelStore.state.value.mostRecentSpinnerAtMs).toBeNull();
    expect(channelStore.state.value.pendingPermissions).toEqual([]);
    expect(channelStore.state.value.minimizedSecrets.size).toBe(0);
  });
});

describe('channelStore — scalar setters', () => {
  it('setAlive / setBusy / setShellBusy toggle the matching field', () => {
    channelStore.actions.setAlive(true);
    expect(channelStore.state.value.alive).toBe(true);
    channelStore.actions.setBusy(true);
    expect(channelStore.state.value.busy).toBe(true);
    channelStore.actions.setShellBusy(true);
    expect(channelStore.state.value.shellBusy).toBe(true);
    channelStore.actions.setAlive(false);
    channelStore.actions.setBusy(false);
    channelStore.actions.setShellBusy(false);
    expect(channelStore.state.value).toMatchObject({ alive: false, busy: false, shellBusy: false });
  });

  it('setMostRecentSpinnerAt stores number or null', () => {
    channelStore.actions.setMostRecentSpinnerAt(1234);
    expect(channelStore.state.value.mostRecentSpinnerAtMs).toBe(1234);
    channelStore.actions.setMostRecentSpinnerAt(null);
    expect(channelStore.state.value.mostRecentSpinnerAtMs).toBeNull();
  });
});

describe('channelStore — busySecrets', () => {
  it('markBusySecret adds, clearBusySecret removes', () => {
    channelStore.actions.markBusySecret('sec-a');
    channelStore.actions.markBusySecret('sec-b');
    expect([...channelStore.state.value.busySecrets].sort()).toEqual(['sec-a', 'sec-b']);
    channelStore.actions.clearBusySecret('sec-a');
    expect([...channelStore.state.value.busySecrets]).toEqual(['sec-b']);
  });

  it('markBusySecret is idempotent — second call does not produce a new set reference', () => {
    channelStore.actions.markBusySecret('sec-a');
    const ref1 = channelStore.state.value.busySecrets;
    channelStore.actions.markBusySecret('sec-a');
    const ref2 = channelStore.state.value.busySecrets;
    expect(ref2).toBe(ref1);
  });

  it('clearBusySecret on an unknown secret is a no-op', () => {
    channelStore.actions.markBusySecret('sec-a');
    const ref1 = channelStore.state.value.busySecrets;
    channelStore.actions.clearBusySecret('sec-b');
    expect(channelStore.state.value.busySecrets).toBe(ref1);
  });
});

describe('channelStore — auto-mode', () => {
  it('setChannelAutoMode flips the global toggle', () => {
    channelStore.actions.setChannelAutoMode(true);
    expect(channelStore.state.value.channelAutoMode).toBe(true);
    channelStore.actions.setChannelAutoMode(false);
    expect(channelStore.state.value.channelAutoMode).toBe(false);
  });

  it('setAutoModeForProject persists per-secret in the map', () => {
    channelStore.actions.setAutoModeForProject('sec-a', true);
    channelStore.actions.setAutoModeForProject('sec-b', false);
    expect(channelStore.state.value.autoModeByProject.get('sec-a')).toBe(true);
    expect(channelStore.state.value.autoModeByProject.get('sec-b')).toBe(false);
    expect(channelStore.state.value.autoModeByProject.get('sec-c')).toBeUndefined();
  });

  it('setAutoModeForProject overwrites the prior value for the same secret', () => {
    channelStore.actions.setAutoModeForProject('sec-a', true);
    channelStore.actions.setAutoModeForProject('sec-a', false);
    expect(channelStore.state.value.autoModeByProject.get('sec-a')).toBe(false);
  });

  it('setChannelAutoBackoff replaces, incrementChannelAutoBackoff adds 1', () => {
    channelStore.actions.setChannelAutoBackoff(5);
    expect(channelStore.state.value.channelAutoBackoff).toBe(5);
    channelStore.actions.incrementChannelAutoBackoff();
    expect(channelStore.state.value.channelAutoBackoff).toBe(6);
    channelStore.actions.setChannelAutoBackoff(0);
    expect(channelStore.state.value.channelAutoBackoff).toBe(0);
  });
});

describe('channelStore — pendingPermissions', () => {
  it('pushPendingPermission appends to the end of the queue', () => {
    channelStore.actions.pushPendingPermission(entry('sec-a', 'r1'));
    channelStore.actions.pushPendingPermission(entry('sec-b', 'r2'));
    expect(channelStore.state.value.pendingPermissions.map(e => e.perm.request_id))
      .toEqual(['r1', 'r2']);
  });

  it('pushPendingPermission dedups by request_id (HS-8219 gate)', () => {
    channelStore.actions.pushPendingPermission(entry('sec-a', 'r1'));
    channelStore.actions.pushPendingPermission(entry('sec-a', 'r1'));
    expect(channelStore.state.value.pendingPermissions).toHaveLength(1);
  });

  it('popPendingPermission removes & returns the LAST entry (LIFO)', () => {
    channelStore.actions.pushPendingPermission(entry('sec-a', 'r1'));
    channelStore.actions.pushPendingPermission(entry('sec-b', 'r2'));
    const top = channelStore.actions.popPendingPermission();
    expect(top?.perm.request_id).toBe('r2');
    expect(channelStore.state.value.pendingPermissions.map(e => e.perm.request_id))
      .toEqual(['r1']);
  });

  it('popPendingPermission on an empty stack returns null', () => {
    expect(channelStore.actions.popPendingPermission()).toBeNull();
  });

  it('retainPendingPermissions drops entries whose request_id is missing', () => {
    channelStore.actions.pushPendingPermission(entry('sec-a', 'r1'));
    channelStore.actions.pushPendingPermission(entry('sec-b', 'r2'));
    channelStore.actions.pushPendingPermission(entry('sec-c', 'r3'));
    channelStore.actions.retainPendingPermissions(new Set(['r1', 'r3']));
    expect(channelStore.state.value.pendingPermissions.map(e => e.perm.request_id))
      .toEqual(['r1', 'r3']);
  });

  it('retainPendingPermissions is a no-op when every entry survives (no new ref)', () => {
    channelStore.actions.pushPendingPermission(entry('sec-a', 'r1'));
    const ref1 = channelStore.state.value.pendingPermissions;
    channelStore.actions.retainPendingPermissions(new Set(['r1']));
    expect(channelStore.state.value.pendingPermissions).toBe(ref1);
  });

  it('retainPendingPermissions(emptySet) clears the queue', () => {
    channelStore.actions.pushPendingPermission(entry('sec-a', 'r1'));
    channelStore.actions.retainPendingPermissions(new Set<string>());
    expect(channelStore.state.value.pendingPermissions).toEqual([]);
  });
});

describe('channelStore — minimizedSecrets', () => {
  it('setMinimizedSecrets replaces the whole set', () => {
    channelStore.actions.setMinimizedSecrets(new Set(['sec-a', 'sec-b']));
    expect([...channelStore.state.value.minimizedSecrets].sort()).toEqual(['sec-a', 'sec-b']);
    channelStore.actions.setMinimizedSecrets(new Set(['sec-c']));
    expect([...channelStore.state.value.minimizedSecrets]).toEqual(['sec-c']);
    channelStore.actions.setMinimizedSecrets(new Set());
    expect(channelStore.state.value.minimizedSecrets.size).toBe(0);
  });
});
