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
  drainAllPoolWorkers, drainPoolWorker, getSuggestedWorkerCount, getTicketPartition, getWorkerPool, launchWorker,
  type PoolState, registerPoolWorker, removePoolWorker, removeWorktree,
  setPoolTarget, setQueueOnlyWorker, type WorkerSlotView,
} from '../api/index.js';
import { getErrorMessage } from '../utils/errorMessage.js';
import { confirmDialog } from './confirm.js';
import { dispatchAndReport, dispatchTicketsToWorker } from './dispatch.js';
import { toElement } from './dom.js';
import { draggedTicketIds, setDraggedTicketIds } from './ticketListState.js';
import { showToast } from './toast.js';

let activeOverlay: HTMLElement | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Workers whose stopped-cleanup is already running, so a poll mid-cleanup doesn't double-run it. */
const cleaningUp = new Set<string>();
/** Adds launched but not yet registered, counted toward the live total so the
 *  reconciler doesn't over-add while a launch is in flight (HS-8971). */
let pendingAdds = 0;

const POLL_MS = 3000;
/** A small machine-sensible ceiling so the stepper can't accidentally fork-bomb. */
const MAX_TARGET = 16;

export function closeWorkerPoolPanel(): void {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
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

/** Build one worker tile. `onDrain` is omitted once the worker is draining/stopped.
 *  Exported for unit tests. */
export function renderWorkerTile(
  w: WorkerSlotView,
  onDrain?: (w: WorkerSlotView) => void,
  onDispatch?: (w: WorkerSlotView, ticketIds: number[]) => void,
  onQueueOnly?: (w: WorkerSlotView, queueOnly: boolean) => void,
): HTMLElement {
  const canDrain = w.state === 'idle' || w.state === 'working';
  const tile = toElement(
    <div className="worker-tile" data-worker={w.worker} data-state={w.state}>
      <div className="worker-tile-head">
        <span className="worker-tile-label">{w.label}</span>
        <span className={`worker-tile-state worker-tile-state-${w.state}`}>{STATE_LABEL[w.state]}</span>
      </div>
      <div className="worker-tile-ticket">
        {w.currentTicket !== null
          ? <span>{w.currentTicket.ticketNumber}: {w.currentTicket.title}</span>
          : <span className="worker-tile-ticket-none">{w.state === 'stopped' || w.state === 'dead' ? 'cleaning up…' : '—'}</span>}
      </div>
      <div className="worker-tile-actions">
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
  onStep: (delta: number) => void, onDrainAll: () => void, onSuggest: () => void, onPartition: () => void,
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
        <button type="button" className="btn btn-sm worker-pool-suggest" title="Let AI suggest a worker count for the current Up Next set">AI: suggest</button>
        <button type="button" className="btn btn-sm worker-pool-partition" disabled={running === 0} title="Let AI split Up Next across the running workers, then dispatch">AI: partition</button>
        <button type="button" className="btn btn-sm worker-pool-drain-all" disabled={running === 0}>Drain all</button>
      </div>
    </div>,
  ));
  controlsEl.querySelector('.worker-pool-step-up')?.addEventListener('click', () => onStep(1));
  controlsEl.querySelector('.worker-pool-step-down')?.addEventListener('click', () => onStep(-1));
  controlsEl.querySelector('.worker-pool-suggest')?.addEventListener('click', () => onSuggest());
  controlsEl.querySelector('.worker-pool-partition')?.addEventListener('click', () => onPartition());
  controlsEl.querySelector('.worker-pool-drain-all')?.addEventListener('click', () => onDrainAll());
}

/** Tear down a finished worker — `stopped` (drained gracefully) or `dead`
 *  (HS-8972, silent past the liveness window): close its terminal, remove its
 *  worktree, and unregister it. Idempotent per worker via `cleaningUp`. After a
 *  reap, the HS-8971 reconcile recreates a replacement if still below target N. */
async function cleanupStopped(w: WorkerSlotView): Promise<void> {
  if (cleaningUp.has(w.worker)) return;
  cleaningUp.add(w.worker);
  try {
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

/** Fetch + render the pool into `bodyEl`, refresh the controls, auto-clean any
 *  stopped workers, and reconcile the live count toward the target. Exported for
 *  tests. */
export async function refreshPool(bodyEl: HTMLElement): Promise<void> {
  let pool: PoolState;
  try {
    pool = await getWorkerPool();
  } catch (e) {
    bodyEl.replaceChildren(toElement(<div className="worker-pool-error">Couldn't load the worker pool: {getErrorMessage(e)}</div>));
    return;
  }
  if (pool.workers.length === 0) {
    bodyEl.replaceChildren(toElement(<div className="worker-pool-empty">No workers. Use + to start workers draining Up Next in parallel.</div>));
  } else {
    const tiles = pool.workers.map(w => renderWorkerTile(
      w,
      (ww) => void handleDrain(ww, pool, bodyEl),
      (ww, ids) => void dispatchAndReport(ww.worker, ww.label, ids).then(() => refreshPool(bodyEl)),
      (ww, q) => void handleQueueOnly(ww, q, bodyEl),
    ));
    bodyEl.replaceChildren(...tiles);
  }
  // Controls live in the singleton overlay (absent in unit tests that pass a bare body).
  const controlsEl = activeOverlay?.querySelector<HTMLElement>('.worker-pool-controls');
  if (controlsEl) {
    renderPoolControls(controlsEl, pool.targetN, activeCount(pool),
      (delta) => void handleStep(pool, delta, bodyEl),
      () => void handleDrainAll(bodyEl),
      () => void handleSuggest(bodyEl),
      () => void handlePartition(pool, bodyEl));
  }
  // Auto-clean finished workers (best-effort, in the background): gracefully
  // drained (`stopped`) or reaped-as-dead (`dead`, HS-8972). Toast once per reap
  // (guarded by `cleaningUp` so a mid-cleanup poll doesn't re-toast).
  for (const w of pool.workers) {
    if ((w.state === 'stopped' || w.state === 'dead') && !cleaningUp.has(w.worker)) {
      if (w.state === 'dead') showToast(`Worker ${w.label} looked unresponsive — reaped`);
      void cleanupStopped(w).then(() => refreshPool(bodyEl));
    }
  }
  // Reconcile the live count toward the target (HS-8971).
  reconcile(pool, bodyEl);
}

/** Add/drain to move the live worker count toward `pool.targetN`. Idempotent +
 *  guarded by `pendingAdds` so concurrent polls don't over-add. Scale-down always
 *  uses graceful drain (never kills mid-ticket); idle workers are drained first. */
function reconcile(pool: PoolState, bodyEl: HTMLElement): void {
  const target = pool.targetN;
  const active = activeCount(pool) + pendingAdds;
  if (active < target) {
    for (let i = 0; i < target - active; i++) void addOneWorker(bodyEl);
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
 *  reconciler doesn't retry the same failing launch every poll. */
async function addOneWorker(bodyEl: HTMLElement): Promise<void> {
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
    await refreshPool(bodyEl);
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

/** HS-8963 — ask the AI (or the heuristic fallback) to suggest a worker count for
 *  the current Up Next set, then offer to apply it (the owner confirms — they
 *  always set the actual N). */
async function handleSuggest(bodyEl: HTMLElement): Promise<void> {
  let suggestion;
  try {
    suggestion = await getSuggestedWorkerCount();
  } catch (e) {
    showToast(`Couldn't get a suggestion: ${getErrorMessage(e)}`);
    return;
  }
  if (suggestion.n === 0) {
    showToast(suggestion.rationale);
    return;
  }
  const apply = await confirmDialog({
    title: `Suggested: ${String(suggestion.n)} worker${suggestion.n === 1 ? '' : 's'}`,
    message: `${suggestion.rationale}\n\nSet the target to ${String(suggestion.n)}?`,
    confirmLabel: `Set target to ${String(suggestion.n)}`,
  });
  if (!apply) return;
  try {
    await setPoolTarget({ targetN: suggestion.n });
    await refreshPool(bodyEl);
  } catch (e) {
    showToast(`Couldn't set worker count: ${getErrorMessage(e)}`);
  }
}

/** HS-8965 — ask the AI (or round-robin fallback) to partition the unblocked Up
 *  Next set across the running workers, show the proposed split, and on confirm
 *  dispatch each chunk to its worker. */
async function handlePartition(pool: PoolState, bodyEl: HTMLElement): Promise<void> {
  const live = pool.workers
    .filter(w => w.state === 'idle' || w.state === 'working')
    .map(w => ({ worker: w.worker, label: w.label }));
  if (live.length === 0) {
    showToast('Add a worker first, then partition Up Next across the pool.');
    return;
  }
  let assignments;
  try {
    assignments = await getTicketPartition({ workers: live });
  } catch (e) {
    showToast(`Couldn't partition: ${getErrorMessage(e)}`);
    return;
  }
  const nonEmpty = assignments.filter(a => a.ticketIds.length > 0);
  if (nonEmpty.length === 0) {
    showToast('Nothing to partition — no unblocked Up Next tickets.');
    return;
  }
  const preview = nonEmpty.map(a => `${a.label} ← ${a.ticketNumbers.join(', ')}`).join('\n');
  const apply = await confirmDialog({
    title: 'Dispatch this partition?',
    message: preview,
    confirmLabel: 'Dispatch',
  });
  if (!apply) return;
  let dispatched = 0;
  const failures: string[] = [];
  for (const a of nonEmpty) {
    const r = await dispatchTicketsToWorker(a.worker, a.label, a.ticketIds);
    dispatched += r.dispatched;
    failures.push(...r.failures);
  }
  showToast(failures.length === 0
    ? `Dispatched ${String(dispatched)} ticket${dispatched === 1 ? '' : 's'} across ${String(nonEmpty.length)} worker${nonEmpty.length === 1 ? '' : 's'}`
    : `Dispatched ${String(dispatched)}; ${String(failures.length)} failed (${[...new Set(failures)].join('; ')})`);
  await refreshPool(bodyEl);
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
      </div>
    </div>,
  );

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeWorkerPoolPanel(); });
  overlay.querySelector('.worker-pool-close')?.addEventListener('click', closeWorkerPoolPanel);
  document.addEventListener('keydown', onKeydown, true);

  const bodyEl = overlay.querySelector<HTMLElement>('.worker-pool-body')!;

  document.body.appendChild(overlay);
  activeOverlay = overlay;
  void refreshPool(bodyEl);
  pollTimer = setInterval(() => void refreshPool(bodyEl), POLL_MS);
}
