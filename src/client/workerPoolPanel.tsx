// HS-8962 — worker-pool panel (docs/91 §91.5). A minimal dashboard over the
// durable worker pool: one tile per worker (label, state, current ticket), an
// "+ add worker" control, per-worker "Drain", and "Drain all". Scaling reuses the
// HS-8863 launcher + §89 worktree primitives; graceful drain is server-coordinated
// (the worker stops at its next claim-next, finishing its current ticket first),
// and a worker that has acknowledged the drain (state `stopped`) is auto-cleaned
// (terminal closed + worktree removed). Live updates are poll-based for now (the
// §90.8 / HS-7945 event bus once it ships); dispatch drop targets (HS-8961) and
// the richer claimed-by chip (HS-8864) layer onto these tiles later.
import {
  drainAllPoolWorkers, drainPoolWorker, getWorkerPool, launchWorker,
  registerPoolWorker, removePoolWorker, removeWorktree, type WorkerSlotView,
} from '../api/index.js';
import { getErrorMessage } from '../utils/errorMessage.js';
import { toElement } from './dom.js';
import { showToast } from './toast.js';

let activeOverlay: HTMLElement | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Workers whose stopped-cleanup is already running, so a poll mid-cleanup doesn't double-run it. */
const cleaningUp = new Set<string>();

const POLL_MS = 3000;

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
  idle: 'Idle', working: 'Working', draining: 'Draining…', stopped: 'Stopped',
};

/** Build one worker tile. `onDrain` is omitted once the worker is draining/stopped.
 *  Exported for unit tests. */
export function renderWorkerTile(w: WorkerSlotView, onDrain?: (w: WorkerSlotView) => void): HTMLElement {
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
          : <span className="worker-tile-ticket-none">{w.state === 'stopped' ? 'cleaning up…' : '—'}</span>}
      </div>
      <div className="worker-tile-actions">
        {canDrain && onDrain !== undefined
          ? <button type="button" className="btn btn-sm worker-drain-btn">Drain</button>
          : null}
      </div>
    </div>,
  );
  if (canDrain && onDrain !== undefined) {
    tile.querySelector('.worker-drain-btn')?.addEventListener('click', () => onDrain(w));
  }
  return tile;
}

/** Tear down a worker that has acknowledged its drain (state `stopped`): close its
 *  terminal, remove its worktree, and unregister it from the pool. Idempotent per
 *  worker via `cleaningUp`. */
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

/** Fetch + render the pool into `bodyEl`, auto-cleaning any stopped workers.
 *  Exported for tests. */
export async function refreshPool(bodyEl: HTMLElement): Promise<void> {
  let pool;
  try {
    pool = await getWorkerPool();
  } catch (e) {
    bodyEl.replaceChildren(toElement(<div className="worker-pool-error">Couldn't load the worker pool: {getErrorMessage(e)}</div>));
    return;
  }
  if (pool.workers.length === 0) {
    bodyEl.replaceChildren(toElement(<div className="worker-pool-empty">No workers. Add one to start draining Up Next in parallel.</div>));
  } else {
    const tiles = pool.workers.map(w => renderWorkerTile(w, (ww) => void handleDrain(ww, bodyEl)));
    bodyEl.replaceChildren(...tiles);
  }
  // Auto-clean drained workers (best-effort, in the background).
  for (const w of pool.workers) {
    if (w.state === 'stopped') void cleanupStopped(w).then(() => refreshPool(bodyEl));
  }
}

/** Choose the next `worker-N` label not already used by a live slot. */
function nextWorkerName(existing: WorkerSlotView[]): string {
  let n = 1;
  const used = new Set(existing.map(w => w.label));
  while (used.has(`worker-${n}`)) n++;
  return `worker-${n}`;
}

async function handleAddWorker(bodyEl: HTMLElement): Promise<void> {
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
    await refreshPool(bodyEl);
  } catch (e) {
    showToast(`Couldn't add worker: ${getErrorMessage(e)}`);
  }
}

async function handleDrain(w: WorkerSlotView, bodyEl: HTMLElement): Promise<void> {
  try {
    await drainPoolWorker({ worker: w.worker });
    showToast(`Draining ${w.label} — it'll stop after its current ticket`);
    await refreshPool(bodyEl);
  } catch (e) {
    showToast(`Drain failed: ${getErrorMessage(e)}`);
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
        <div className="worker-pool-controls">
          <button type="button" className="btn btn-sm worker-pool-add">+ Add worker</button>
          <button type="button" className="btn btn-sm worker-pool-drain-all">Drain all</button>
        </div>
      </div>
    </div>,
  );

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeWorkerPoolPanel(); });
  overlay.querySelector('.worker-pool-close')?.addEventListener('click', closeWorkerPoolPanel);
  document.addEventListener('keydown', onKeydown, true);

  const bodyEl = overlay.querySelector<HTMLElement>('.worker-pool-body')!;
  overlay.querySelector('.worker-pool-add')?.addEventListener('click', () => void handleAddWorker(bodyEl));
  overlay.querySelector('.worker-pool-drain-all')?.addEventListener('click', () => void handleDrainAll(bodyEl));

  document.body.appendChild(overlay);
  activeOverlay = overlay;
  void refreshPool(bodyEl);
  pollTimer = setInterval(() => void refreshPool(bodyEl), POLL_MS);
}
