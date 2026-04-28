// Shared change-tracking state for long-poll support.
// All route groups that mutate data call notifyChange() to wake poll waiters.

import { subscribeToGitChanges } from '../git/watcher.js';
import { scheduleAllSync } from '../sync/markdown.js';

// HS-7954 — git status changes (commits / stages / branch switches made
// outside Hot Sheet) wake the same poll waiters Hot Sheet's own mutations
// do, so subscribed clients refetch `/api/git/status` and re-render the
// chip without the user needing to alt-tab. Subscribed once at module
// load — process-lifetime, no need to GC.
subscribeToGitChanges(() => { notifyChange(); });

let changeVersion = 0;
let pollWaiters: Array<(version: number) => void> = [];

export function notifyChange() {
  changeVersion++;
  const waiters = pollWaiters;
  pollWaiters = [];
  for (const resolve of waiters) {
    resolve(changeVersion);
  }
  // Also wake permission waiters — the channel server calls notifyChange()
  // via POST /api/channel/notify which is proven to work reliably.
  notifyPermission();
}

export function getChangeVersion() {
  return changeVersion;
}

export function addPollWaiter(resolve: (version: number) => void) {
  pollWaiters.push(resolve);
}

/** Convenience: schedule markdown sync and wake long-poll waiters in one call. */
export function notifyMutation(dataDir: string) {
  scheduleAllSync(dataDir);
  notifyChange();
}

// --- Permission long-poll support ---
// Uses a version counter to avoid race conditions between check and wait.

let permissionVersion = 0;
let permissionWaiters: Array<() => void> = [];

export function getPermissionVersion() {
  return permissionVersion;
}

export function addPermissionWaiter(resolve: () => void) {
  permissionWaiters.push(resolve);
}

/** Wake all waiting permission long-poll connections. */
export function notifyPermission() {
  permissionVersion++;
  const waiters = permissionWaiters;
  permissionWaiters = [];
  for (const resolve of waiters) resolve();
}

// --- Cross-project bell long-poll support (HS-6603 §24.3.4) ---
// Mirrors the permission-waiter pattern. Bumped any time a terminal's
// bellPending flag flips in either direction (set by the PTY data handler
// on 0x07; cleared by POST /api/terminal/clear-bell).

let bellVersion = 0;
let bellWaiters: Array<() => void> = [];

export function getBellVersion() {
  return bellVersion;
}

export function addBellWaiter(resolve: () => void) {
  bellWaiters.push(resolve);
}

/** Wake all waiting bell-state long-poll connections. */
export function notifyBellWaiters() {
  bellVersion++;
  const waiters = bellWaiters;
  bellWaiters = [];
  for (const resolve of waiters) resolve();
}
