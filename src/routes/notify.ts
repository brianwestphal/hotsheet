// Shared change-tracking state for long-poll support.
// All route groups that mutate data call notifyChange() to wake poll waiters.

import { scheduleAllSync } from '../sync/markdown.js';

let changeVersion = 0;
let pollWaiters: Array<(version: number) => void> = [];

export function notifyChange() {
  changeVersion++;
  const waiters = pollWaiters;
  pollWaiters = [];
  for (const resolve of waiters) {
    resolve(changeVersion);
  }
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

let permissionWaiters: Array<() => void> = [];

export function addPermissionWaiter(resolve: () => void) {
  permissionWaiters.push(resolve);
}

/** Wake all waiting permission long-poll connections. */
export function notifyPermission() {
  const waiters = permissionWaiters;
  permissionWaiters = [];
  for (const resolve of waiters) resolve();
}
