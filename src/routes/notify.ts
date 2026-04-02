// Shared change-tracking state for long-poll support.
// All route groups that mutate data call notifyChange() to wake poll waiters.

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
