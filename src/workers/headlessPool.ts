/**
 * HS-9110 (docs/100 §100.2.1(a)) — the server-readable "headless worker pool"
 * enable signal.
 *
 * The client-side Auto switch (§91.11, `workerAutoMode.ts`) lives in browser
 * localStorage, so the server can't tell whether headless auto-scaling is allowed
 * — and a server loop that spawns `claude` worker processes with **no human
 * present** needs an explicit, server-readable enable (§100.3). This is that
 * signal: a per-project `FileSettings` key the Auto toggle also writes, so turning
 * Auto on enables the server's periodic reconcile loop (`poolReconcileTimer.ts`)
 * to keep healing/scaling the pool with no UI open.
 *
 * The key is machine-LOCAL (in `LOCAL_SCOPE_KEYS`, → `settings.local.json`):
 * whether THIS machine may spawn headless workers is a per-device decision, never
 * something committed for the team.
 */
import { readFileSettings } from '../file-settings.js';

/** Project-settings key the Auto switch writes + the server loop reads. */
export const HEADLESS_POOL_SETTING_KEY = 'headless_worker_pool';

/** Whether headless pool scaling is enabled for a project. Tolerates both a
 *  native boolean (`writeFileSettings`) and the string `'true'` (the project
 *  settings API stringifies values via `writeProjectSettings`). */
export function isHeadlessPoolEnabled(dataDir: string): boolean {
  const v: unknown = readFileSettings(dataDir)[HEADLESS_POOL_SETTING_KEY];
  return v === true || v === 'true';
}
