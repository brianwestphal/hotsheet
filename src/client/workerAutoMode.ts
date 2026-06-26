// HS-9039 — "Auto" worker-pool mode. A per-project switch in the sidebar (above
// the play button) that auto-manages the durable worker pool (docs/91 §91.7),
// replacing the manual stepper / AI-suggest / AI-partition dance the maintainer
// found "overly complicated":
//
//   - it sizes the pool to the current Up Next workload (the existing
//     `/workers/suggest-n` recommendation, AI or heuristic), then
//   - the existing reconciler (`syncPoolHeadless`) allocates the worktrees +
//     terminals, and
//   - the self-claim primitive (claim-next) distributes the tickets across the
//     workers — no explicit partition needed.
//
// Cost note: sizing consults `/workers/suggest-n`, which MAY call a model, so the
// loop re-sizes on a SLOW cadence (~once a minute) while the cheap reconcile/
// cleanup tick runs frequently. Turning Auto OFF stops the auto-sizing but leaves
// any running workers to finish (they're durable; drain them from the panel).
import { getSuggestedWorkerCount, setPoolTarget, updateSettings } from '../api/index.js';
import { getActiveProject } from './state.js';
import { showToast } from './toast.js';
import { MAX_TARGET, syncPoolHeadless } from './workerPoolPanel.js';

const STORAGE_KEY = 'hotsheet:worker-auto-mode';
/** Fast reconcile/cleanup cadence (cheap — just the pool fetch + launch/drain). */
const RECONCILE_MS = 4000;
/** Re-size (consult the suggestion endpoint) every Nth reconcile tick. At
 *  RECONCILE_MS = 4 s that's ~once a minute, bounding AI-suggestion cost. */
const SUGGEST_EVERY = 15;

// --- Per-project persistence (localStorage map of projectSecret -> enabled) ---

function readMap(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return out;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return out;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'boolean') out.set(k, v);
    }
  } catch {
    /* corrupt / unavailable localStorage → treat as empty */
  }
  return out;
}

function writeMap(map: Map<string, boolean>): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(map))); } catch { /* localStorage may be unavailable */ }
}

/** Whether Auto is persisted on for a given project secret. */
export function isAutoModeEnabled(secret: string): boolean {
  return readMap().get(secret) ?? false;
}

/** Persist the Auto flag for a project (pure storage write). Exported for tests. */
export function setAutoModeEnabledPersisted(secret: string, on: boolean): void {
  const map = readMap();
  map.set(secret, on);
  writeMap(map);
}

/** Pure: should this tick re-size the pool (vs. just reconcile)? Exported for tests. */
export function shouldResizeOnTick(tickCount: number, every: number = SUGGEST_EVERY): boolean {
  return tickCount % every === 0;
}

// --- The control loop ---

function activeSecret(): string | null {
  const s = getActiveProject()?.secret;
  return s !== undefined && s !== '' ? s : null;
}

/** Auto runs only when the active project has it on AND the channel play section
 *  is visible (workers need a connected Claude to do anything). Reads the DOM so
 *  the gate stays decoupled from `channelUI`. */
function shouldRun(): boolean {
  const secret = activeSecret();
  if (secret === null || !isAutoModeEnabled(secret)) return false;
  const section = document.getElementById('channel-play-section');
  return section !== null && section.style.display !== 'none';
}

let loopTimer: ReturnType<typeof setInterval> | null = null;
let tickCount = 0;
let resizing = false;

/** Re-size the pool target from the current Up Next suggestion. Best-effort:
 *  swallows transient errors (the next slow tick retries) and guards against
 *  overlapping evaluations. */
async function resizePool(): Promise<void> {
  if (resizing) return;
  resizing = true;
  try {
    const sug = await getSuggestedWorkerCount();
    const n = Math.max(0, Math.min(MAX_TARGET, Math.round(sug.n)));
    await setPoolTarget({ targetN: n });
  } catch {
    /* transient — the next slow tick retries */
  } finally {
    resizing = false;
  }
}

async function tick(): Promise<void> {
  if (!shouldRun()) { stopLoop(); return; }
  if (shouldResizeOnTick(tickCount)) await resizePool();
  tickCount++;
  try { await syncPoolHeadless(); } catch { /* retry next tick */ }
}

function startLoop(): void {
  if (loopTimer !== null) return;
  tickCount = 0;
  void tick();
  loopTimer = setInterval(() => void tick(), RECONCILE_MS);
}

function stopLoop(): void {
  if (loopTimer !== null) { clearInterval(loopTimer); loopTimer = null; }
}

/** Start or stop the loop to match the active project's Auto flag + channel
 *  state. Call on boot, on every project switch, and after a toggle. */
export function applyAutoModeForActiveProject(): void {
  if (shouldRun()) startLoop();
  else stopLoop();
}

/** Reflect the active project's persisted Auto flag onto the checkbox, then
 *  start/stop the loop. Call on boot + after each project switch. */
export function syncWorkerAutoModeUI(): void {
  const cb = document.getElementById('worker-auto-checkbox');
  const secret = activeSecret();
  if (cb instanceof HTMLInputElement) cb.checked = secret !== null && isAutoModeEnabled(secret);
  applyAutoModeForActiveProject();
}

/** Bind the Auto checkbox's change handler once (at boot). */
export function bindWorkerAutoToggle(): void {
  const cb = document.getElementById('worker-auto-checkbox');
  if (!(cb instanceof HTMLInputElement)) return;
  cb.addEventListener('change', () => {
    const secret = activeSecret();
    if (secret === null) { cb.checked = false; return; }
    setAutoModeEnabledPersisted(secret, cb.checked);
    // HS-9110 — also write the SERVER-readable enable so the server's periodic
    // reconcile loop (docs/100 §100.2.1(a)) keeps scaling the pool with no UI
    // open. Best-effort: localStorage already drives the in-window loop.
    void updateSettings({ headless_worker_pool: String(cb.checked) }).catch(() => { /* transient */ });
    applyAutoModeForActiveProject();
    showToast(cb.checked
      ? 'Auto worker pool on — sizing the pool to Up Next automatically'
      : 'Auto worker pool off — running workers will finish their current work');
  });
}

/** Stop the loop (tests / teardown). */
export function _stopAutoModeForTesting(): void { stopLoop(); tickCount = 0; }
