/**
 * HS-9135 — the shared long-poll waiter registry (`routes/notify.ts`). Pure
 * version-counter + waiter-list logic; the git-watcher subscription + markdown
 * sync (its only module-load / side-effect deps) are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addBellWaiter, addPermissionWaiter, addPollWaiter,
  getBellVersion, getChangeVersion, getDataVersion, getPermissionVersion,
  notifyBellWaiters, notifyChange, notifyMutation, notifyPermission,
  wakeAllWaitersForShutdown,
} from './notify.js';

const scheduleAllSyncMock = vi.hoisted(() => vi.fn());
vi.mock('../git/watcher.js', () => ({ subscribeToGitChanges: vi.fn() }));
vi.mock('../sync/markdown.js', () => ({ scheduleAllSync: scheduleAllSyncMock }));

beforeEach(() => { scheduleAllSyncMock.mockReset(); });

describe('change/data versions + poll waiters', () => {
  it('notifyChange bumps changeVersion and resolves+clears poll waiters', () => {
    const before = getChangeVersion();
    let got: number | null = null;
    addPollWaiter(v => { got = v; });
    notifyChange();
    expect(getChangeVersion()).toBe(before + 1);
    expect(got).toBe(before + 1);
    // The waiter list was cleared — a second notify doesn't re-resolve it.
    got = null;
    notifyChange();
    expect(got).toBeNull();
  });

  it('notifyMutation schedules markdown sync, bumps dataVersion, and bumps changeVersion', () => {
    const dataBefore = getDataVersion();
    const changeBefore = getChangeVersion();
    notifyMutation('/some/dataDir');
    expect(scheduleAllSyncMock).toHaveBeenCalledWith('/some/dataDir');
    expect(getDataVersion()).toBe(dataBefore + 1);
    expect(getChangeVersion()).toBe(changeBefore + 1);
  });

  it('notifyChange also wakes permission waiters (it calls notifyPermission)', () => {
    let permResolved = false;
    addPermissionWaiter(() => { permResolved = true; });
    notifyChange();
    expect(permResolved).toBe(true);
  });
});

describe('permission waiters', () => {
  it('notifyPermission bumps the version and resolves+clears waiters', () => {
    const before = getPermissionVersion();
    let resolved = false;
    addPermissionWaiter(() => { resolved = true; });
    notifyPermission();
    expect(getPermissionVersion()).toBe(before + 1);
    expect(resolved).toBe(true);
  });
});

describe('bell waiters', () => {
  it('notifyBellWaiters bumps the version and resolves+clears waiters', () => {
    const before = getBellVersion();
    let resolved = false;
    addBellWaiter(() => { resolved = true; });
    notifyBellWaiters();
    expect(getBellVersion()).toBe(before + 1);
    expect(resolved).toBe(true);
  });
});

describe('wakeAllWaitersForShutdown', () => {
  it('resolves every pending waiter (data + permission + bell)', () => {
    let poll = false, perm = false, bell = false;
    addPollWaiter(() => { poll = true; });
    addPermissionWaiter(() => { perm = true; });
    addBellWaiter(() => { bell = true; });
    wakeAllWaitersForShutdown();
    expect([poll, perm, bell]).toEqual([true, true, true]);
  });
});
