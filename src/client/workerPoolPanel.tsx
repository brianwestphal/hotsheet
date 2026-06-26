// HS-8962 — worker-pool panel (docs/91 §91.5). A minimal dashboard over the
// durable worker pool: one tile per worker (label, state, current ticket), a
// target-N stepper the panel reconciles toward (HS-8971), per-worker "Drain", and
// "Drain all". Scaling reuses the HS-8863 launcher + §89 worktree primitives;
// graceful drain is server-coordinated (the worker stops at its next claim-next,
// finishing its current ticket first), and a worker that has acknowledged the
// drain (state `stopped`) is auto-cleaned (terminal closed + worktree removed).
// Live updates are poll-based for now (the §90.8 / HS-7945 event bus once it
// ships); dispatch drop targets (HS-8961) + the richer claimed-by chip (HS-8864)
// layer onto these tiles later.
import {
  drainAllPoolWorkers, drainPoolWorker, getGlassboxStatus, getTicketClaims, getWorkerPool, launchWorker,
  type PoolState, registerPoolWorker, releaseTicket, removePoolWorker, removeWorktree, reviewInGlassbox,
  setPoolTarget, setQueueOnlyWorker, type WorkerSlotView,
} from '../api/index.js';
import type { SafeHtml } from '../jsx-runtime.js';
import { getErrorMessage } from '../utils/errorMessage.js';
import { isChannelAlive, isChannelBusy, triggerChannelAndMarkBusy } from './channelUI.js';
import { confirmDialog } from './confirm.js';
import { dispatchAndReport } from './dispatch.js';
import { toElement } from './dom.js';
import { draggedTicketIds, setDraggedTicketIds } from './ticketListState.js';
import { showToast } from './toast.js';

let activeOverlay: HTMLElement | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** HS-9082 — whether the Glassbox CLI is installed (probed once on panel open).
 *  Gates the per-tile "Review" affordance so we never show a button that errors. */
let glassboxAvailable = false;
/** Workers whose stopped-cleanup is already running, so a poll mid-cleanup doesn't double-run it. */
const cleaningUp = new Set<string>();
/** Adds launched but not yet registered, counted toward the live total so the
 *  reconciler doesn't over-add while a launch is in flight (HS-8971). */
let pendingAdds = 0;

const POLL_MS = 3000;
/** A small machine-sensible ceiling so the stepper can't accidentally fork-bomb. */
export const MAX_TARGET = 16;

/** HS-9039 — a single "pool changed" listener the engine notifies after a
 *  background add/cleanup, so the open panel re-renders without the engine
 *  holding a DOM reference. Null when no panel is open (e.g. headless auto mode,
 *  which re-syncs on its own timer). */
type PoolChangeListener = () => void;
let onPoolChanged: PoolChangeListener | null = null;
export function setPoolChangeListener(listener: PoolChangeListener | null): void {
  onPoolChanged = listener;
}
function notifyPoolChanged(): void { onPoolChanged?.(); }

export function closeWorkerPoolPanel(): void {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
  setPoolChangeListener(null);
  if (activeOverlay !== null) {
    activeOverlay.remove();
    activeOverlay = null;
    document.removeEventListener('keydown', onKeydown, true);
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.preventDefault(); closeWorkerPoolPanel(); }
}

const STATE_LABEL: Record<WorkerSlotView['state'], string> = {
  idle: 'Idle', working: 'Working', draining: 'Draining…', stopped: 'Stopped', dead: 'Unresponsive',
};

/** Workers that count toward the live total (everything not on its way out). */
function activeCount(pool: PoolState): number {
  return pool.workers.filter(w => w.state === 'idle' || w.state === 'working').length;
}

/** HS-9081 (docs/102 §102.3) — human-readable tooltip for a worker's git chip.
 *  Exported for tests. */
export function gitChipTitle(git: { ahead: number; behind: number; dirty: boolean }): string {
  const parts: string[] = [];
  if (git.ahead > 0) parts.push(`${String(git.ahead)} commit(s) ahead of the target`);
  if (git.behind > 0) parts.push(`${String(git.behind)} behind (needs rebase)`);
  parts.push(git.dirty ? 'uncommitted changes' : 'working tree clean');
  return parts.join(' · ');
}

/** HS-9081 — the compact per-worktree git chip (`↑3 ↓1 •dirty`) for a worker
 *  tile. Returns null when there's nothing to show (no git summary, or 0
 *  ahead/behind + clean) so a tidy worker adds no clutter. */
function renderGitChip(git: WorkerSlotView['git']): SafeHtml | null {
  if (git === undefined) return null;
  if (git.ahead === 0 && git.behind === 0 && !git.dirty) return null;
  return (
    <span className="worker-tile-git" title={gitChipTitle(git)}>
      {git.ahead > 0 ? <span className="worker-tile-git-ahead">↑{git.ahead}</span> : null}
      {git.behind > 0 ? <span className="worker-tile-git-behind">↓{git.behind}</span> : null}
      {git.dirty ? <span className="worker-tile-git-dirty">•dirty</span> : null}
    </span>
  );
}

/** Build one worker tile. `onDrain` is omitted once the worker is draining/stopped.
 *  Exported for unit tests. */
export function renderWorkerTile(
  w: WorkerSlotView,
  onDrain?: (w: WorkerSlotView) => void,
  onDispatch?: (w: WorkerSlotView, ticketIds: number[]) => void,
  onQueueOnly?: (w: WorkerSlotView, queueOnly: boolean) => void,
  onReview?: (w: WorkerSlotView) => void, // HS-9082 — open Glassbox on this worker's branch vs the target
): HTMLElement {
  const canDrain = w.state === 'idle' || w.state === 'working';
  // HS-9082 — offer a "Review" affordance only when there's committed work to
  // diff against the target (ahead > 0) on a known branch + Glassbox is wired.
  const canReview = onReview !== undefined && w.branch !== null && (w.git?.ahead ?? 0) > 0;
  const tile = toElement(
    <div className="worker-tile" data-worker={w.worker} data-state={w.state}>
      <div className="worker-tile-head">
        <span className="worker-tile-label">{w.label}</span>
        {/* HS-9081 — per-worktree git state: ahead/behind vs target + dirty. */}
        {renderGitChip(w.git)}
        {/* HS-9090 — explicit "branch ready to integrate" signal. */}
        {w.ready && w.readyBranch !== null
          ? <span className="worker-tile-ready" title={`${w.readyBranch} is committed, rebased, and ready to integrate`}>● ready</span>
          : null}
        <span className={`worker-tile-state worker-tile-state-${w.state}`}>{STATE_LABEL[w.state]}</span>
      </div>
      <div className="worker-tile-ticket">
        {w.currentTicket !== null
          ? <span>{w.currentTicket.ticketNumber}: {w.currentTicket.title}</span>
          : <span className="worker-tile-ticket-none">{w.state === 'stopped' || w.state === 'dead' ? 'cleaning up…' : '—'}</span>}
      </div>
      <div className="worker-tile-actions">
        {/* HS-9082 — review what integrating this worker's branch adds, in Glassbox.
            Shown for any state with committed work (incl. stopped/dead — its branch
            is still integratable), so it sits before the drain controls. */}
        {canReview
          ? <button type="button" className="btn btn-sm worker-review-btn" title={`Review what integrating ${w.branch ?? ''} adds vs the target branch, in Glassbox`}>Review</button>
          : null}
        {canDrain && onQueueOnly !== undefined
          ? <label className="worker-queue-only" title="Work only dispatched tickets, then stop (don't self-claim from the shared pool)">
              <input type="checkbox" className="worker-queue-only-cb" checked={w.queueOnly} /> queue-only
            </label>
          : null}
        {canDrain && onDrain !== undefined
          ? <button type="button" className="btn btn-sm worker-drain-btn">Drain</button>
          : null}
      </div>
    </div>,
  );
  if (canReview) {
    tile.querySelector('.worker-review-btn')?.addEventListener('click', () => onReview(w));
  }
  if (canDrain && onDrain !== undefined) {
    tile.querySelector('.worker-drain-btn')?.addEventListener('click', () => onDrain(w));
  }
  if (canDrain && onQueueOnly !== undefined) {
    const cb = tile.querySelector<HTMLInputElement>('.worker-queue-only-cb');
    cb?.addEventListener('change', () => onQueueOnly(w, cb.checked));
  }
  // HS-8964 — drag-to-worker dispatch (docs/92 §92.2). A ticket drag in flight
  // (`draggedTicketIds`, §76) can be dropped onto a NON-draining tile to dispatch
  // those tickets to this worker. Draining/stopped tiles aren't drop targets.
  if (canDrain && onDispatch !== undefined) {
    tile.addEventListener('dragover', (e) => {
      if (draggedTicketIds.length === 0) return;
      e.preventDefault();
      if (e.dataTransfer !== null) e.dataTransfer.dropEffect = 'move';
      tile.classList.add('drag-over');
    });
    tile.addEventListener('dragleave', () => tile.classList.remove('drag-over'));
    tile.addEventListener('drop', (e) => {
      if (draggedTicketIds.length === 0) return;
      e.preventDefault();
      tile.classList.remove('drag-over');
      const ids = [...draggedTicketIds];
      setDraggedTicketIds([]);
      onDispatch(w, ids);
    });
  }
  return tile;
}

/** Render the target-N stepper + "drain all" into the controls bar. Exported for
 *  tests. `target` is the server's stored target; `running` is the live count. */
export function renderPoolControls(
  controlsEl: HTMLElement, target: number, running: number,
  onStep: (delta: number) => void, onDrainAll: () => void,
  readyCount = 0,
): void {
  controlsEl.replaceChildren(toElement(
    <div className="worker-pool-controls-inner">
      <div className="worker-pool-stepper">
        <button type="button" className="btn btn-sm worker-pool-step-down" disabled={target <= 0} title="Drain one worker">−</button>
        <span className="worker-pool-target" title="Target worker count">{String(target)}</span>
        <button type="button" className="btn btn-sm worker-pool-step-up" disabled={target >= MAX_TARGET} title="Add one worker">+</button>
        <span className="worker-pool-running">{`${String(running)} running`}</span>
      </div>
      <div className="worker-pool-controls-right">
        {/* HS-9090 — explicit "branch ready" queue, surfaced at a glance. */}
        {readyCount > 0
          ? <span className="worker-pool-ready" title="Worker branches signaled committed + rebased + ready to integrate">{`${String(readyCount)} ${readyCount === 1 ? 'branch' : 'branches'} ready to integrate`}</span>
          : null}
        <button type="button" className="btn btn-sm worker-pool-drain-all" disabled={running === 0}>Drain all</button>
      </div>
    </div>,
  ));
  controlsEl.querySelector('.worker-pool-step-up')?.addEventListener('click', () => onStep(1));
  controlsEl.querySelector('.worker-pool-step-down')?.addEventListener('click', () => onStep(-1));
  controlsEl.querySelector('.worker-pool-drain-all')?.addEventListener('click', () => onDrainAll());
}

/**
 * HS-9079 (docs/101 §101.1) — wrap the owner's natural-language instruction in a
 * worker-management directive for the MAIN agent. The agent carries it out with
 * the shipped worker MCP tools (query → size → partition → dispatch). Pure +
 * exported for tests. The actual orchestration is the agent's job at runtime;
 * this only builds the prompt it receives over the channel.
 */
export function buildWorkerManagementPrompt(instruction: string): string {
  return [
    'You are managing the Hot Sheet worker pool. The owner asked:',
    '',
    `«${instruction.trim()}»`,
    '',
    'Carry it out using the worker MCP tools — do NOT do the tickets\' work yourself:',
    '- `hotsheet_query_tickets` — resolve the exact set the request names (by tag / category / status / free-text). If nothing matches or the request is ambiguous, say so and stop.',
    '- `hotsheet_set_worker_target` — size the pool to fit that set (use the suggest-N heuristic; the pool enforces its own maximum, so never try to exceed it).',
    '- partition the set into coherent per-worker batches: group small/related tickets (shared files/area, shared tag/category) together, isolate large/risky ones, and never put a ticket in the same batch as one of its own `blocked_by` dependencies.',
    '- `hotsheet_dispatch_tickets` — dispatch each batch to a specific worker.',
    '',
    'Show the proposed assignment (which tickets → which worker) for the owner to review before dispatching when you can. Report the outcome (sized to N, dispatched M tickets across K workers) when done.',
  ].join('\n');
}

/**
 * HS-9079 — send a worker-management instruction to the main agent over the
 * channel. Gated on the channel being connected; busy-aware (warn before stacking
 * onto a mid-task main agent, per §101.4). No-op on an empty instruction.
 * Exported for tests.
 */
export async function submitWorkerPrompt(instruction: string): Promise<void> {
  const trimmed = instruction.trim();
  if (trimmed === '') return;
  if (!isChannelAlive()) {
    showToast('Claude is not connected. Launch Claude Code with channel support first.', { variant: 'warning' });
    return;
  }
  if (isChannelBusy()) {
    const ok = await confirmDialog({
      title: 'Main agent is busy',
      message: 'The main agent is mid-task. This worker-management request will queue behind its current work. Send it anyway?',
      confirmLabel: 'Send',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
  }
  triggerChannelAndMarkBusy(buildWorkerManagementPrompt(trimmed));
  showToast('Sent to the main agent — it will query, size, partition, and dispatch.', { variant: 'success' });
}

/** HS-9079 — render the prompt text box + "Go" into `promptEl`. `onSubmit` fires
 *  with the trimmed instruction on Go or Enter (no-op on empty); the input clears
 *  after a submit. Exported for tests. */
export function renderPoolPrompt(promptEl: HTMLElement, onSubmit: (instruction: string) => void): void {
  promptEl.replaceChildren(toElement(
    <div className="worker-pool-prompt-inner">
      <input
        type="text"
        className="worker-pool-prompt-input"
        placeholder="Tell the pool what to parallelize (e.g. “parallelize tickets tagged refactor”)"
        aria-label="Worker-pool instruction"
      />
      <button type="button" className="btn btn-sm worker-pool-prompt-go">Go</button>
    </div>,
  ));
  const input = promptEl.querySelector<HTMLInputElement>('.worker-pool-prompt-input');
  const go = promptEl.querySelector<HTMLButtonElement>('.worker-pool-prompt-go');
  const submit = (): void => {
    if (input === null) return;
    const value = input.value.trim();
    if (value === '') return;
    input.value = '';
    onSubmit(value);
  };
  go?.addEventListener('click', submit);
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
}

/** Tear down a finished worker — `stopped` (drained gracefully) or `dead`
 *  (HS-8972, silent past the liveness window): close its terminal, remove its
 *  worktree, and unregister it. Idempotent per worker via `cleaningUp`. After a
 *  reap, the HS-8971 reconcile recreates a replacement if still below target N. */
async function cleanupStopped(w: WorkerSlotView): Promise<void> {
  if (cleaningUp.has(w.worker)) return;
  cleaningUp.add(w.worker);
  try {
    // HS-9051 — force-release any tickets still leased to this dead/stopped worker
    // FIRST, so another worker can reclaim them within this ~5 min reap window
    // rather than waiting out the 30-min lease TTL (HS-9050). Best-effort +
    // idempotent; never blocks the teardown.
    await releaseWorkerClaims(w.worker);
    if (w.terminalId !== null) {
      const { closeDynamicTerminal } = await import('./terminalInstanceLifecycle.js');
      await closeDynamicTerminal(w.terminalId, true);
    }
    await removeWorktree({ path: w.worktreePath, force: true });
    await removePoolWorker({ worker: w.worker });
  } catch (e) {
    showToast(`Worker cleanup failed: ${getErrorMessage(e)}`);
  } finally {
    cleaningUp.delete(w.worker);
  }
}

/** HS-9051 — force-release every live ticket lease held by `worker` (owner
 *  force-release, no worker arg). Best-effort: a claims-fetch or release failure
 *  is swallowed so it can't block the reap teardown. Exported for tests. */
export async function releaseWorkerClaims(worker: string): Promise<void> {
  try {
    const claims = await getTicketClaims();
    await Promise.all(
      claims
        .filter(cl => cl.claimedBy === worker)
        .map(cl => releaseTicket(cl.ticketId).catch(() => { /* idempotent / best-effort */ })),
    );
  } catch {
    /* a claims-fetch / unexpected error must never block the reap teardown */
  }
}

/** HS-9039 — headless pool sync (NO DOM): fetch the pool, auto-clean any finished
 *  workers, and reconcile the live count toward the target. Shared by the panel
 *  (which then renders) and headless auto mode (`workerAutoMode.ts`), which
 *  re-syncs on its own timer. Throws if the pool can't be fetched — callers decide
 *  how to surface that (the panel renders an error tile; auto mode ignores + retries). */
export async function syncPoolHeadless(): Promise<PoolState> {
  const pool = await getWorkerPool();
  // Auto-clean finished workers (best-effort, in the background): gracefully
  // drained (`stopped`) or reaped-as-dead (`dead`, HS-8972). Toast once per reap
  // (guarded by `cleaningUp` so a mid-cleanup poll doesn't re-toast). On
  // completion, notify the open panel (if any) to re-render.
  for (const w of pool.workers) {
    if ((w.state === 'stopped' || w.state === 'dead') && !cleaningUp.has(w.worker)) {
      if (w.state === 'dead') showToast(`Worker ${w.label} looked unresponsive — reaped`);
      void cleanupStopped(w).then(notifyPoolChanged);
    }
  }
  // Reconcile the live count toward the target (HS-8971).
  reconcile(pool);
  return pool;
}

/** Fetch + render the pool into `bodyEl` and refresh the controls. The data work
 *  (cleanup + reconcile) is delegated to `syncPoolHeadless`. Exported for tests. */
export async function refreshPool(bodyEl: HTMLElement): Promise<void> {
  let pool: PoolState;
  try {
    pool = await syncPoolHeadless();
  } catch (e) {
    bodyEl.replaceChildren(toElement(<div className="worker-pool-error">Couldn't load the worker pool: {getErrorMessage(e)}</div>));
    return;
  }
  if (pool.workers.length === 0) {
    bodyEl.replaceChildren(toElement(<div className="worker-pool-empty">No workers. Use + to start workers draining Up Next in parallel.</div>));
  } else {
    // HS-9082 — wire "Review" only when Glassbox is installed + we know the target
    // branch to diff against (so the menu can build `target..hotsheet/worker-N`).
    const onReview = glassboxAvailable && pool.target != null && pool.target !== ''
      ? (ww: WorkerSlotView) => void reviewWorkerBranch(ww, pool.target)
      : undefined;
    const tiles = pool.workers.map(w => renderWorkerTile(
      w,
      (ww) => void handleDrain(ww, pool, bodyEl),
      (ww, ids) => void dispatchAndReport(ww.worker, ww.label, ids).then(() => refreshPool(bodyEl)),
      (ww, q) => void handleQueueOnly(ww, q, bodyEl),
      onReview,
    ));
    bodyEl.replaceChildren(...tiles);
  }
  // Controls live in the singleton overlay (absent in unit tests that pass a bare body).
  const controlsEl = activeOverlay?.querySelector<HTMLElement>('.worker-pool-controls');
  if (controlsEl) {
    renderPoolControls(controlsEl, pool.targetN, activeCount(pool),
      (delta) => void handleStep(pool, delta, bodyEl),
      () => void handleDrainAll(bodyEl), pool.readyCount);
  }
}

/** HS-9082 — open Glassbox on the diff of `w.branch` vs the integration `target`
 *  ("what integrating this worker's branch adds") — the `target..hotsheet/worker-N`
 *  range. Toasts on failure (e.g. the Glassbox CLI vanished between the open-time
 *  probe and the click). Exported for tests. */
export async function reviewWorkerBranch(w: WorkerSlotView, target: string | null | undefined): Promise<void> {
  if (w.branch === null || target == null || target === '') {
    showToast('No target branch to diff against.', { variant: 'warning' });
    return;
  }
  try {
    await reviewInGlassbox({ mode: 'range', from: target, to: w.branch });
  } catch {
    showToast('Could not open Glassbox. Make sure the Glassbox CLI is installed.', { variant: 'warning' });
  }
}

/** Add/drain to move the live worker count toward `pool.targetN`. Idempotent +
 *  guarded by `pendingAdds` so concurrent polls don't over-add. Scale-down always
 *  uses graceful drain (never kills mid-ticket); idle workers are drained first. */
function reconcile(pool: PoolState): void {
  const target = pool.targetN;
  const active = activeCount(pool) + pendingAdds;
  if (active < target) {
    for (let i = 0; i < target - active; i++) void addOneWorker();
  } else if (active > target) {
    const candidates = [
      ...pool.workers.filter(w => w.state === 'idle'),
      ...pool.workers.filter(w => w.state === 'working'),
    ];
    for (let i = 0; i < active - target && i < candidates.length; i++) {
      void drainPoolWorker({ worker: candidates[i].worker }).catch(() => { /* next poll retries */ });
    }
  }
}

/** Choose the next `worker-N` label not already used by a live slot. */
function nextWorkerName(existing: WorkerSlotView[]): string {
  let n = 1;
  const used = new Set(existing.map(w => w.label));
  while (used.has(`worker-${n}`)) n++;
  return `worker-${n}`;
}

/** Launch + open + register one worker. On failure, lower the target by one so the
 *  reconciler doesn't retry the same failing launch every poll. Notifies the open
 *  panel (if any) to re-render once the launch settles. */
async function addOneWorker(): Promise<void> {
  pendingAdds++;
  try {
    const pool = await getWorkerPool();
    const name = nextWorkerName(pool.workers);
    const spec = await launchWorker({ branch: `hotsheet/${name}` });
    const { openTerminalRunningCommand } = await import('./terminal.js');
    const terminalId = await openTerminalRunningCommand(spec.command, spec.label, spec.cwd);
    await registerPoolWorker({
      label: spec.label, worker: spec.worker, worktreePath: spec.cwd,
      branch: `hotsheet/${name}`, terminalId,
    });
    showToast(`Worker ${spec.label} started`);
  } catch (e) {
    showToast(`Couldn't add worker: ${getErrorMessage(e)}`);
    try {
      const pool = await getWorkerPool();
      await setPoolTarget({ targetN: Math.max(0, pool.targetN - 1) });
    } catch { /* best-effort target backoff */ }
  } finally {
    pendingAdds--;
    notifyPoolChanged();
  }
}

/** Step the target up/down by `delta` (clamped to [0, MAX_TARGET]); the next
 *  refresh reconciles toward it. */
async function handleStep(pool: PoolState, delta: number, bodyEl: HTMLElement): Promise<void> {
  const next = Math.max(0, Math.min(MAX_TARGET, pool.targetN + delta));
  if (next === pool.targetN) return;
  try {
    await setPoolTarget({ targetN: next });
    await refreshPool(bodyEl);
  } catch (e) {
    showToast(`Couldn't set worker count: ${getErrorMessage(e)}`);
  }
}

/** Drain one specific worker AND lower the target by one so the reconciler doesn't
 *  immediately replace it. */
async function handleDrain(w: WorkerSlotView, pool: PoolState, bodyEl: HTMLElement): Promise<void> {
  try {
    await drainPoolWorker({ worker: w.worker });
    await setPoolTarget({ targetN: Math.max(0, pool.targetN - 1) });
    showToast(`Draining ${w.label} — it'll stop after its current ticket`);
    await refreshPool(bodyEl);
  } catch (e) {
    showToast(`Drain failed: ${getErrorMessage(e)}`);
  }
}

/** HS-8975 — toggle a worker's queue-only mode (work only dispatched tickets,
 *  then stop instead of self-claiming the shared pool). */
async function handleQueueOnly(w: WorkerSlotView, queueOnly: boolean, bodyEl: HTMLElement): Promise<void> {
  try {
    await setQueueOnlyWorker({ worker: w.worker, queueOnly });
    showToast(queueOnly ? `${w.label}: queue-only (dispatched tickets, then stop)` : `${w.label}: self-claims the shared pool`);
    await refreshPool(bodyEl);
  } catch (e) {
    showToast(`Couldn't update ${w.label}: ${getErrorMessage(e)}`);
  }
}

async function handleDrainAll(bodyEl: HTMLElement): Promise<void> {
  try {
    await drainAllPoolWorkers();
    showToast('Draining all workers');
    await refreshPool(bodyEl);
  } catch (e) {
    showToast(`Drain all failed: ${getErrorMessage(e)}`);
  }
}

/** Open the worker-pool panel (singleton). */
export function openWorkerPoolPanel(): void {
  closeWorkerPoolPanel();
  const overlay = toElement(
    <div className="worker-pool-overlay">
      <div className="worker-pool-dialog" role="dialog" aria-label="Worker pool">
        <div className="worker-pool-header">
          <span className="worker-pool-title">Worker Pool</span>
          <button type="button" className="worker-pool-close" title="Close">{'×'}</button>
        </div>
        <div className="worker-pool-body"></div>
        <div className="worker-pool-controls"></div>
        {/* HS-9079 — natural-language worker-management prompt → the main agent. */}
        <div className="worker-pool-prompt"></div>
      </div>
    </div>,
  );

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeWorkerPoolPanel(); });
  overlay.querySelector('.worker-pool-close')?.addEventListener('click', closeWorkerPoolPanel);
  document.addEventListener('keydown', onKeydown, true);

  const bodyEl = overlay.querySelector<HTMLElement>('.worker-pool-body')!;

  // HS-9079 — the worker-management prompt box (wraps + triggers the main agent).
  const promptEl = overlay.querySelector<HTMLElement>('.worker-pool-prompt');
  if (promptEl) renderPoolPrompt(promptEl, (instruction) => void submitWorkerPrompt(instruction));

  document.body.appendChild(overlay);
  activeOverlay = overlay;
  // Re-render whenever the engine reports a background change (a launch/cleanup
  // started by `syncPoolHeadless`, including ones driven by headless auto mode).
  setPoolChangeListener(() => void refreshPool(bodyEl));
  // HS-9082 — probe Glassbox availability once; re-render so the per-tile "Review"
  // buttons appear as soon as we know (the first paint may precede this).
  void getGlassboxStatus().then((s) => {
    glassboxAvailable = s.available;
    if (s.available) void refreshPool(bodyEl);
  }).catch(() => { /* probe failed — leave Review hidden */ });
  void refreshPool(bodyEl);
  pollTimer = setInterval(() => void refreshPool(bodyEl), POLL_MS);
}
