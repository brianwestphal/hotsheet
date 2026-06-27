// @vitest-environment happy-dom
// HS-8962 + HS-8971 — worker-pool panel tests (docs/91 §91.5): tile rendering per
// state, the target-N stepper + reconcile (add/drain toward N), drain wiring, and
// auto-cleanup of a stopped worker (close terminal + remove worktree + unregister).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  drainPoolWorker, getTags, getTicketClaims, getTicketPartition, getWorkerPool, launchWorker, type PoolState,
  registerPoolWorker, releaseTicket, removePoolWorker, removeWorktree, reviewInGlassbox, setPoolTarget,
type WorkerSlotView,
} from '../api/index.js';
import { isChannelAlive, isChannelBusy, triggerChannelAndMarkBusy } from './channelUI.js';
import { confirmDialog } from './confirm.js';
import { openPartitionEditor } from './partitionEditor.js';
import { setActiveProject } from './state.js';
import { closeDynamicTerminal } from './terminalInstanceLifecycle.js';
import { _stopAutoModeForTesting, setAutoModeEnabledPersisted } from './workerAutoMode.js';
import {
  _resetReconcileStateForTesting, adoptServerWorkerTerminals, buildReviewModeItems, buildWorkerManagementPrompt,
  closeWorkerPoolPanel, gitChipTitle, parallelizeTag, refreshPool, releaseWorkerClaims, renderPoolControls,
  renderPoolPrompt, renderWorkerTile, reviewWorkerBranch, reviewWorkerWorktree, serverOwnsSpawning, submitWorkerPrompt,
  syncPoolHeadless,
} from './workerPoolPanel.js';

vi.mock('../api/index.js', () => ({
  getWorkerPool: vi.fn(),
  launchWorker: vi.fn(),
  registerPoolWorker: vi.fn(),
  drainPoolWorker: vi.fn(),
  drainAllPoolWorkers: vi.fn(),
  removePoolWorker: vi.fn(),
  removeWorktree: vi.fn(),
  setPoolTarget: vi.fn(),
  getSuggestedWorkerCount: vi.fn(),
  getTicketPartition: vi.fn().mockResolvedValue([]),
  getTicketClaims: vi.fn(),
  releaseTicket: vi.fn(),
  getGlassboxStatus: vi.fn().mockResolvedValue({ available: false }),
  reviewInGlassbox: vi.fn().mockResolvedValue({ ok: true }),
  getTags: vi.fn().mockResolvedValue([]),
}));
vi.mock('./toast.js', () => ({ showToast: vi.fn() }));
// HS-9080 — the partition editor is opened by parallelizeTag; mock it so tests
// assert the call without rendering a real overlay.
vi.mock('./partitionEditor.js', () => ({ openPartitionEditor: vi.fn(), closePartitionEditor: vi.fn() }));
vi.mock('./confirm.js', () => ({ confirmDialog: vi.fn() }));
// HS-9079 — the prompt box routes through the channel to the main agent.
vi.mock('./channelUI.js', () => ({
  isChannelAlive: vi.fn(() => true),
  isChannelBusy: vi.fn(() => false),
  triggerChannelAndMarkBusy: vi.fn(),
}));
vi.mock('./terminalInstanceLifecycle.js', () => ({ closeDynamicTerminal: vi.fn() }));
vi.mock('./terminal.js', () => ({
  openTerminalRunningCommand: vi.fn().mockResolvedValue('term-new'),
  // HS-9078 — adoption reads the rendered config list + reloads tabs to attach a
  // server-spawned worker's existing PTY.
  getLastKnownTerminalConfigs: vi.fn(() => ({ configured: [], dynamic: [] })),
  loadAndRenderTerminalTabs: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./dispatch.js', () => ({
  dispatchAndReport: vi.fn().mockResolvedValue({ dispatched: 0, failed: [], failures: [] }),
  dispatchTicketsToWorker: vi.fn().mockResolvedValue({ dispatched: 0, failed: [], failures: [] }),
}));
// HS-8964 — controllable drag set for the drop-target tests.
const dragHolder = vi.hoisted(() => ({ ids: [] as number[] }));
vi.mock('./ticketListState.js', () => ({
  draggedTicketIds: dragHolder.ids,
  setDraggedTicketIds: vi.fn((ids: number[]) => { dragHolder.ids.length = 0; dragHolder.ids.push(...ids); }),
}));

const mockPool = vi.mocked(getWorkerPool);
const mockLaunch = vi.mocked(launchWorker);
const mockRegister = vi.mocked(registerPoolWorker);
const mockDrain = vi.mocked(drainPoolWorker);
const mockRemove = vi.mocked(removePoolWorker);
const mockRemoveWt = vi.mocked(removeWorktree);
const mockSetTarget = vi.mocked(setPoolTarget);
const mockCloseTerm = vi.mocked(closeDynamicTerminal);

const slot = (over: Partial<WorkerSlotView> = {}): WorkerSlotView => ({
  label: 'worker-1', worker: 'pw1', worktreePath: '/wt/pw1', branch: 'hotsheet/worker-1',
  terminalId: 't-pw1', state: 'idle', currentTicket: null, queueOnly: false,
  ready: false, readyBranch: null, ...over,
});

/** Build a `PoolState` for the mocked `getWorkerPool` (HS-9090 added `readyCount`). */
const pool = (over: Partial<PoolState> = {}): PoolState => ({
  targetN: 0, workers: [], readyCount: 0, ...over,
});

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '';
  dragHolder.ids.length = 0;
  localStorage.clear(); // HS-9078 — reset Auto/headless persistence so serverOwnsSpawning defaults false
  _resetReconcileStateForTesting(); // HS-9078 — clear any leaked pendingAdds/cleaningUp from a prior test
  vi.clearAllMocks();
  mockDrain.mockResolvedValue({ ok: true });
  mockRemove.mockResolvedValue({ ok: true });
  mockRemoveWt.mockResolvedValue({ ok: true });
  mockSetTarget.mockResolvedValue({ ok: true });
  mockCloseTerm.mockResolvedValue(undefined);
  mockLaunch.mockResolvedValue({ worker: 'pw2', label: 'worker-2', cwd: '/wt/pw2', command: 'claude "/hotsheet-worker"', worktreeCreated: true });
  mockRegister.mockResolvedValue(slot({ worker: 'pw2', label: 'worker-2' }));
});
afterEach(() => closeWorkerPoolPanel());

describe('renderWorkerTile (HS-8962)', () => {
  it('working tile shows the current ticket + a wired Drain button', () => {
    const onDrain = vi.fn();
    const tile = renderWorkerTile(slot({ state: 'working', currentTicket: { id: 5, ticketNumber: 'HS-5', title: 'do it' } }), onDrain);
    expect(tile.querySelector('.worker-tile-state')?.textContent).toBe('Working');
    expect(tile.querySelector('.worker-tile-ticket')?.textContent).toContain('HS-5');
    tile.querySelector<HTMLButtonElement>('.worker-drain-btn')!.click();
    expect(onDrain).toHaveBeenCalledWith(expect.objectContaining({ worker: 'pw1' }));
  });

  it('idle tile has a Drain button; draining + stopped tiles do not', () => {
    expect(renderWorkerTile(slot({ state: 'idle' }), vi.fn()).querySelector('.worker-drain-btn')).not.toBeNull();
    expect(renderWorkerTile(slot({ state: 'draining' }), vi.fn()).querySelector('.worker-drain-btn')).toBeNull();
    expect(renderWorkerTile(slot({ state: 'stopped' }), vi.fn()).querySelector('.worker-drain-btn')).toBeNull();
    expect(renderWorkerTile(slot({ state: 'draining' })).querySelector('.worker-tile-state')?.textContent).toBe('Draining…');
  });

  it('HS-8964 — dropping a ticket drag on a live tile dispatches it to that worker', () => {
    const onDispatch = vi.fn();
    const tile = renderWorkerTile(slot({ state: 'idle' }), vi.fn(), onDispatch);
    dragHolder.ids.push(1, 2);
    tile.dispatchEvent(new Event('drop', { bubbles: true }));
    expect(onDispatch).toHaveBeenCalledWith(expect.objectContaining({ worker: 'pw1' }), [1, 2]);
  });

  it('HS-8964 — a draining tile is not a drop target', () => {
    const onDispatch = vi.fn();
    const tile = renderWorkerTile(slot({ state: 'draining' }), vi.fn(), onDispatch);
    dragHolder.ids.push(1);
    tile.dispatchEvent(new Event('drop', { bubbles: true }));
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it('HS-9090 — a ready worker shows a "ready" badge naming its branch; an unready one does not', () => {
    const readyTile = renderWorkerTile(slot({ ready: true, readyBranch: 'hotsheet/worker-1' }));
    const badge = readyTile.querySelector('.worker-tile-ready');
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute('title')).toContain('hotsheet/worker-1');
    expect(renderWorkerTile(slot({ ready: false })).querySelector('.worker-tile-ready')).toBeNull();
  });

  // HS-9081 (docs/102 §102.3) — the per-worktree git chip on the tile.
  it('renders a git chip with ↑ahead / ↓behind / •dirty when the worker has unmerged or uncommitted work', () => {
    const tile = renderWorkerTile(slot({ git: { ahead: 3, behind: 1, dirty: true } }));
    const chip = tile.querySelector('.worker-tile-git');
    expect(chip).not.toBeNull();
    expect(chip!.querySelector('.worker-tile-git-ahead')?.textContent).toBe('↑3');
    expect(chip!.querySelector('.worker-tile-git-behind')?.textContent).toBe('↓1');
    expect(chip!.querySelector('.worker-tile-git-dirty')?.textContent).toBe('•dirty');
    expect(chip!.getAttribute('title')).toContain('ahead');
  });

  it('omits the parts that are zero/clean (e.g. ahead-only shows ↑ but no ↓ / dirty)', () => {
    const tile = renderWorkerTile(slot({ git: { ahead: 2, behind: 0, dirty: false } }));
    const chip = tile.querySelector('.worker-tile-git');
    expect(chip!.querySelector('.worker-tile-git-ahead')?.textContent).toBe('↑2');
    expect(chip!.querySelector('.worker-tile-git-behind')).toBeNull();
    expect(chip!.querySelector('.worker-tile-git-dirty')).toBeNull();
  });

  it('shows no git chip for a clean, in-sync worker or when the summary is absent', () => {
    expect(renderWorkerTile(slot({ git: { ahead: 0, behind: 0, dirty: false } })).querySelector('.worker-tile-git')).toBeNull();
    expect(renderWorkerTile(slot()).querySelector('.worker-tile-git')).toBeNull(); // git undefined
  });

  // HS-9082 (docs/102 §102.2) — per-tile "Review" affordance → Glassbox diff vs target.
  it('shows a wired Review button when the worker has committed work + onReview is provided', () => {
    const onReview = vi.fn();
    const tile = renderWorkerTile(slot({ git: { ahead: 2, behind: 0, dirty: false } }), vi.fn(), undefined, undefined, onReview);
    const btn = tile.querySelector<HTMLButtonElement>('.worker-review-btn');
    expect(btn).not.toBeNull();
    btn!.click();
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ worker: 'pw1' }));
  });

  it('hides Review when there is no committed work (ahead 0), no branch, or no onReview', () => {
    // ahead 0 → nothing to integrate/review.
    expect(renderWorkerTile(slot({ git: { ahead: 0, behind: 1, dirty: true } }), vi.fn(), undefined, undefined, vi.fn()).querySelector('.worker-review-btn')).toBeNull();
    // no branch → can't build a range.
    expect(renderWorkerTile(slot({ branch: null, git: { ahead: 2, behind: 0, dirty: false } }), vi.fn(), undefined, undefined, vi.fn()).querySelector('.worker-review-btn')).toBeNull();
    // onReview omitted (Glassbox unavailable / no target) → no button.
    expect(renderWorkerTile(slot({ git: { ahead: 2, behind: 0, dirty: false } })).querySelector('.worker-review-btn')).toBeNull();
  });

  it('offers Review even for a stopped worker whose branch still has integratable commits', () => {
    const tile = renderWorkerTile(slot({ state: 'stopped', git: { ahead: 3, behind: 0, dirty: false } }), vi.fn(), undefined, undefined, vi.fn());
    expect(tile.querySelector('.worker-review-btn')).not.toBeNull();
    // …and a stopped worker still has no Drain button.
    expect(tile.querySelector('.worker-drain-btn')).toBeNull();
  });
});

describe('gitChipTitle (HS-9081)', () => {
  it('describes ahead/behind/dirty in words', () => {
    expect(gitChipTitle({ ahead: 3, behind: 1, dirty: true }))
      .toBe('3 commit(s) ahead of the target · 1 behind (needs rebase) · uncommitted changes');
  });
  it('says the tree is clean when not dirty', () => {
    expect(gitChipTitle({ ahead: 0, behind: 0, dirty: false })).toBe('working tree clean');
  });
});

describe('reviewWorkerBranch (HS-9082)', () => {
  const slot = (over: Partial<WorkerSlotView> = {}): WorkerSlotView => ({
    label: 'worker-1', worker: 'pw1', worktreePath: '/wt/pw1', branch: 'hotsheet/worker-1',
    terminalId: 't-pw1', state: 'idle', currentTicket: null, queueOnly: false,
    ready: false, readyBranch: null, ...over,
  });

  it('opens Glassbox on the target..branch range ("what integrating this branch adds")', async () => {
    const review = vi.mocked(reviewInGlassbox);
    review.mockClear();
    await reviewWorkerBranch(slot({ branch: 'hotsheet/worker-1' }), 'main');
    expect(review).toHaveBeenCalledWith({ mode: 'range', from: 'main', to: 'hotsheet/worker-1' });
  });

  it('no-ops (no Glassbox call) when the branch or target is missing', async () => {
    const review = vi.mocked(reviewInGlassbox);
    review.mockClear();
    await reviewWorkerBranch(slot({ branch: null }), 'main');
    await reviewWorkerBranch(slot({ branch: 'hotsheet/worker-1' }), null);
    await reviewWorkerBranch(slot({ branch: 'hotsheet/worker-1' }), '');
    expect(review).not.toHaveBeenCalled();
  });
});

describe('reviewWorkerWorktree + review-mode menu (HS-9106)', () => {
  const slot = (over: Partial<WorkerSlotView> = {}): WorkerSlotView => ({
    label: 'worker-1', worker: 'pw1', worktreePath: '/wt/pw1', branch: 'hotsheet/worker-1',
    terminalId: 't-pw1', state: 'idle', currentTicket: null, queueOnly: false,
    ready: false, readyBranch: null, ...over,
  });

  it('opens Glassbox in the worktree (cwd) to review the working state in place', async () => {
    const review = vi.mocked(reviewInGlassbox);
    review.mockClear();
    await reviewWorkerWorktree(slot({ worktreePath: '/wt/pw1' }));
    expect(review).toHaveBeenCalledWith({ mode: 'worktree', worktree: '/wt/pw1' });
  });

  it('buildReviewModeItems offers diff-vs-target (default, first) then review-in-place', () => {
    const onReview = vi.fn();
    const onReviewWorktree = vi.fn();
    const items = buildReviewModeItems(slot(), onReview, onReviewWorktree);
    expect(items.map(i => i.label)).toEqual(['Diff vs target', 'Review worktree in place']);
    items[0].action();
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ worker: 'pw1' }));
    items[1].action();
    expect(onReviewWorktree).toHaveBeenCalledWith(expect.objectContaining({ worker: 'pw1' }));
  });

  it('the Review button gets a contextmenu handler only when onReviewWorktree is provided', () => {
    const withWorktree = renderWorkerTile(
      slot({ git: { ahead: 2, behind: 0, dirty: false } }), vi.fn(), undefined, undefined, vi.fn(), vi.fn());
    const btn = withWorktree.querySelector<HTMLButtonElement>('.worker-review-btn')!;
    // The title hints at the right-click secondary mode.
    expect(btn.title).toContain('right-click');
    // Dispatching contextmenu opens the dropdown menu (rendered into the body).
    btn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(document.querySelector('.dropdown-menu')).not.toBeNull();
    closeWorkerPoolPanel();
  });
});

describe('HS-9078 — client adoption of server-launched workers', () => {
  afterEach(() => { _stopAutoModeForTesting(); localStorage.clear(); });

  it('serverOwnsSpawning gates on the active project + headless enable', () => {
    setActiveProject({ name: 'P', dataDir: '/tmp/p', secret: 's1' });
    expect(serverOwnsSpawning(() => true)).toBe(true);
    expect(serverOwnsSpawning(() => false)).toBe(false);
  });

  it('adoptServerWorkerTerminals reloads tabs when a slot has an unrendered server terminalId', async () => {
    const reloadTabs = vi.fn().mockResolvedValue(undefined);
    const did = await adoptServerWorkerTerminals(
      pool({ workers: [slot({ terminalId: 'srv-1' })] }),
      { knownTerminalIds: () => Promise.resolve(new Set<string>()), reloadTabs },
    );
    expect(did).toBe(true);
    expect(reloadTabs).toHaveBeenCalledOnce();
  });

  it('adoptServerWorkerTerminals is a no-op when every slot terminal is already rendered', async () => {
    const reloadTabs = vi.fn().mockResolvedValue(undefined);
    const did = await adoptServerWorkerTerminals(
      pool({ workers: [slot({ terminalId: 'srv-1' })] }),
      { knownTerminalIds: () => Promise.resolve(new Set<string>(['srv-1'])), reloadTabs },
    );
    expect(did).toBe(false);
    expect(reloadTabs).not.toHaveBeenCalled();
  });

  it('syncPoolHeadless does NOT client-spawn when the server owns spawning (Auto on)', async () => {
    setActiveProject({ name: 'P', dataDir: '/tmp/p', secret: 's-auto' });
    setAutoModeEnabledPersisted('s-auto', true);
    mockPool.mockResolvedValue(pool({ targetN: 2, workers: [] })); // below target
    await syncPoolHeadless();
    await flush();
    expect(mockLaunch).not.toHaveBeenCalled(); // server loop spawns; client adopts
  });

  it('syncPoolHeadless STILL client-spawns when Auto is off (manual path unchanged)', async () => {
    setActiveProject({ name: 'P', dataDir: '/tmp/p', secret: 's-manual' });
    setAutoModeEnabledPersisted('s-manual', false);
    mockPool.mockResolvedValue(pool({ targetN: 1, workers: [] }));
    await syncPoolHeadless();
    await flush();
    expect(mockLaunch).toHaveBeenCalled();
  });

  it('syncPoolHeadless skips client cleanup of a stopped worker when server-owned (no double-reap)', async () => {
    setActiveProject({ name: 'P', dataDir: '/tmp/p', secret: 's-auto2' });
    setAutoModeEnabledPersisted('s-auto2', true);
    mockPool.mockResolvedValue(pool({ targetN: 1, workers: [slot({ state: 'stopped' })] }));
    await syncPoolHeadless();
    await flush();
    expect(mockRemoveWt).not.toHaveBeenCalled(); // server reapWorker handles it
    expect(mockCloseTerm).not.toHaveBeenCalled();
  });
});

describe('renderPoolControls — target stepper (HS-8971)', () => {
  it('shows the target + running count and wires the steppers + drain-all', () => {
    const onStep = vi.fn();
    const onDrainAll = vi.fn();
    const el = document.createElement('div');
    renderPoolControls(el, 2, 1, onStep, onDrainAll);
    expect(el.querySelector('.worker-pool-target')?.textContent).toBe('2');
    expect(el.querySelector('.worker-pool-running')?.textContent).toContain('1 running');
    el.querySelector<HTMLButtonElement>('.worker-pool-step-up')!.click();
    expect(onStep).toHaveBeenCalledWith(1);
    el.querySelector<HTMLButtonElement>('.worker-pool-step-down')!.click();
    expect(onStep).toHaveBeenCalledWith(-1);
    el.querySelector<HTMLButtonElement>('.worker-pool-drain-all')!.click();
    expect(onDrainAll).toHaveBeenCalled();
  });

  // HS-9039 — the AI: suggest / AI: partition buttons were removed (the "Auto
  // worker pool" sidebar switch replaces them). Only the manual stepper +
  // drain-all remain.
  it('no longer renders the AI: suggest / AI: partition buttons', () => {
    const el = document.createElement('div');
    renderPoolControls(el, 2, 1, vi.fn(), vi.fn());
    expect(el.querySelector('.worker-pool-suggest')).toBeNull();
    expect(el.querySelector('.worker-pool-partition')).toBeNull();
  });

  it('disables − at target 0 and Drain all when nothing is running', () => {
    const el = document.createElement('div');
    renderPoolControls(el, 0, 0, vi.fn(), vi.fn());
    expect(el.querySelector<HTMLButtonElement>('.worker-pool-step-down')!.disabled).toBe(true);
    expect(el.querySelector<HTMLButtonElement>('.worker-pool-drain-all')!.disabled).toBe(true);
  });

  it('HS-9090 — surfaces the ready-to-integrate count (singular/plural), hidden at zero', () => {
    const el = document.createElement('div');
    renderPoolControls(el, 2, 2, vi.fn(), vi.fn(), 0);
    expect(el.querySelector('.worker-pool-ready')).toBeNull();
    renderPoolControls(el, 2, 2, vi.fn(), vi.fn(), 1);
    expect(el.querySelector('.worker-pool-ready')?.textContent).toBe('1 branch ready to integrate');
    renderPoolControls(el, 2, 2, vi.fn(), vi.fn(), 3);
    expect(el.querySelector('.worker-pool-ready')?.textContent).toBe('3 branches ready to integrate');
  });
});

describe('refreshPool (HS-8962)', () => {
  it('renders a tile per worker and wires Drain → drainPoolWorker + lowers target', async () => {
    mockPool.mockResolvedValue(pool({ targetN: 1, workers: [slot({ state: 'idle' })] }));
    const body = document.createElement('div');
    await refreshPool(body);
    expect(body.querySelectorAll('.worker-tile')).toHaveLength(1);
    body.querySelector<HTMLButtonElement>('.worker-drain-btn')!.click();
    await flush();
    expect(mockDrain).toHaveBeenCalledWith({ worker: 'pw1' });
    expect(mockSetTarget).toHaveBeenCalledWith({ targetN: 0 }); // drained one → target 1→0
  });

  it('shows an empty state when there are no workers', async () => {
    mockPool.mockResolvedValue(pool({ targetN: 0, workers: [] }));
    const body = document.createElement('div');
    await refreshPool(body);
    expect(body.querySelector('.worker-pool-empty')).not.toBeNull();
  });

  it('auto-cleans a stopped worker: close terminal + remove worktree + unregister', async () => {
    mockPool.mockResolvedValueOnce(pool({ targetN: 0, workers: [slot({ state: 'stopped' })] }));
    mockPool.mockResolvedValue(pool({ targetN: 0, workers: [] }));
    const body = document.createElement('div');
    await refreshPool(body);
    await flush();
    expect(mockCloseTerm).toHaveBeenCalledWith('t-pw1', true);
    expect(mockRemoveWt).toHaveBeenCalledWith({ path: '/wt/pw1', force: true });
    expect(mockRemove).toHaveBeenCalledWith({ worker: 'pw1' });
  });

  it('HS-8972 — auto-reaps a dead (unresponsive) worker, same teardown as stopped', async () => {
    mockPool.mockResolvedValueOnce(pool({ targetN: 0, workers: [slot({ state: 'dead' })] }));
    mockPool.mockResolvedValue(pool({ targetN: 0, workers: [] }));
    const body = document.createElement('div');
    await refreshPool(body);
    await flush();
    expect(mockCloseTerm).toHaveBeenCalledWith('t-pw1', true);
    expect(mockRemoveWt).toHaveBeenCalledWith({ path: '/wt/pw1', force: true });
    expect(mockRemove).toHaveBeenCalledWith({ worker: 'pw1' });
  });

  it('reconcile adds a worker when the live count is below target (HS-8971)', async () => {
    // Target 1 but no live workers → reconcile launches one; then the pool reports it.
    mockPool.mockResolvedValueOnce(pool({ targetN: 1, workers: [] }));
    mockPool.mockResolvedValue(pool({ targetN: 1, workers: [slot({ worker: 'pw2', label: 'worker-2', state: 'idle' })] }));
    const body = document.createElement('div');
    await refreshPool(body);
    await flush();
    expect(mockLaunch).toHaveBeenCalledWith({ branch: 'hotsheet/worker-1' });
    expect(mockRegister).toHaveBeenCalled();
  });

  it('reconcile drains the surplus (idle first) when the live count exceeds target', async () => {
    mockPool.mockResolvedValue(pool({
      targetN: 1,
      workers: [slot({ worker: 'a', label: 'worker-1', state: 'working' }), slot({ worker: 'b', label: 'worker-2', state: 'idle' })],
    }));
    const body = document.createElement('div');
    await refreshPool(body);
    await flush();
    // 2 active, target 1 → drain one, the idle one (b) first.
    expect(mockDrain).toHaveBeenCalledWith({ worker: 'b' });
    expect(mockDrain).not.toHaveBeenCalledWith({ worker: 'a' });
  });

  it('renders an error state when the pool fetch fails', async () => {
    mockPool.mockRejectedValue(new Error('boom'));
    const body = document.createElement('div');
    await refreshPool(body);
    expect(body.querySelector('.worker-pool-error')?.textContent).toContain('boom');
  });
});

describe('releaseWorkerClaims (HS-9051)', () => {
  const claim = (ticketId: number, claimedBy: string) => ({
    ticketId, ticketNumber: `HS-${String(ticketId)}`, title: 't', claimedBy, workerLabel: null, leaseExpiresAt: '2026-01-01T00:00:00Z',
  });

  it('force-releases only the given worker\'s claimed tickets', async () => {
    vi.mocked(getTicketClaims).mockResolvedValue([claim(1, 'worker-1'), claim(2, 'worker-2'), claim(3, 'worker-1')]);
    vi.mocked(releaseTicket).mockResolvedValue({ ok: true });
    await releaseWorkerClaims('worker-1');
    expect(releaseTicket).toHaveBeenCalledWith(1);
    expect(releaseTicket).toHaveBeenCalledWith(3);
    expect(releaseTicket).not.toHaveBeenCalledWith(2);
  });

  it('swallows a claims-fetch failure without releasing anything (best-effort)', async () => {
    vi.mocked(getTicketClaims).mockRejectedValue(new Error('boom'));
    await expect(releaseWorkerClaims('worker-1')).resolves.toBeUndefined();
    expect(releaseTicket).not.toHaveBeenCalled();
  });
});

// HS-9079 (docs/101 §101.1-101.2) — the natural-language worker-management prompt.
describe('buildWorkerManagementPrompt (HS-9079)', () => {
  it('wraps the instruction + names the worker MCP tools (query/size/partition/dispatch)', () => {
    const p = buildWorkerManagementPrompt('  parallelize tickets tagged refactor  ');
    expect(p).toContain('«parallelize tickets tagged refactor»'); // trimmed + quoted
    expect(p).toContain('hotsheet_query_tickets');
    expect(p).toContain('hotsheet_set_worker_target');
    expect(p).toContain('hotsheet_dispatch_tickets');
    expect(p).toContain('partition');
    // It tells the agent to manage, not do the work itself.
    expect(p.toLowerCase()).toContain("do not do the tickets' work yourself");
  });
});

describe('renderPoolPrompt (HS-9079)', () => {
  let host: HTMLElement;
  beforeEach(() => { host = document.createElement('div'); });

  it('submits the trimmed value on Go and clears the input', () => {
    const onSubmit = vi.fn();
    renderPoolPrompt(host, onSubmit);
    const input = host.querySelector<HTMLInputElement>('.worker-pool-prompt-input')!;
    input.value = '  split the backlog  ';
    host.querySelector<HTMLButtonElement>('.worker-pool-prompt-go')!.click();
    expect(onSubmit).toHaveBeenCalledWith('split the backlog');
    expect(input.value).toBe('');
  });

  it('submits on Enter, and does nothing for an empty/whitespace value', () => {
    const onSubmit = vi.fn();
    renderPoolPrompt(host, onSubmit);
    const input = host.querySelector<HTMLInputElement>('.worker-pool-prompt-input')!;
    input.value = '   ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSubmit).not.toHaveBeenCalled();
    input.value = 'parallelize tag x';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSubmit).toHaveBeenCalledWith('parallelize tag x');
  });

  // HS-9080 — the "Parallelize tag…" quick action button.
  it('renders a "Parallelize tag…" button wired to onTagParallelize (with the button as anchor)', () => {
    const onTag = vi.fn();
    renderPoolPrompt(host, vi.fn(), onTag);
    const btn = host.querySelector<HTMLButtonElement>('.worker-pool-parallelize-tag');
    expect(btn).not.toBeNull();
    btn!.click();
    expect(onTag).toHaveBeenCalledWith(btn);
  });
});

describe('parallelizeTag (HS-9080)', () => {
  beforeEach(() => {
    vi.mocked(openPartitionEditor).mockReset();
    vi.mocked(getTicketPartition).mockReset().mockResolvedValue([]);
    vi.mocked(getTags).mockReset().mockResolvedValue([]);
  });

  it('does nothing (no partition, no editor) when there are no live workers', async () => {
    mockPool.mockResolvedValue(pool({ workers: [] }));
    await parallelizeTag('refactor');
    expect(getTicketPartition).not.toHaveBeenCalled();
    expect(openPartitionEditor).not.toHaveBeenCalled();
  });

  it('partitions the tag across live workers and opens the editor when there is work', async () => {
    mockPool.mockResolvedValue(pool({ workers: [slot({ worker: 'pw1', label: 'worker-1', state: 'idle' })] }));
    vi.mocked(getTicketPartition).mockResolvedValue([
      { worker: 'pw1', label: 'worker-1', ticketIds: [1, 2], ticketNumbers: ['HS-1', 'HS-2'] },
    ]);
    await parallelizeTag('refactor');
    expect(getTicketPartition).toHaveBeenCalledWith({ workers: [{ worker: 'pw1', label: 'worker-1' }], tag: 'refactor' });
    expect(openPartitionEditor).toHaveBeenCalledOnce();
  });

  it('excludes dead/stopped workers from the dispatch set', async () => {
    mockPool.mockResolvedValue(pool({ workers: [
      slot({ worker: 'pw1', label: 'worker-1', state: 'idle' }),
      slot({ worker: 'pw2', label: 'worker-2', state: 'dead' }),
      slot({ worker: 'pw3', label: 'worker-3', state: 'stopped' }),
    ] }));
    vi.mocked(getTicketPartition).mockResolvedValue([{ worker: 'pw1', label: 'worker-1', ticketIds: [1], ticketNumbers: ['HS-1'] }]);
    await parallelizeTag('refactor');
    expect(getTicketPartition).toHaveBeenCalledWith({ workers: [{ worker: 'pw1', label: 'worker-1' }], tag: 'refactor' });
  });

  it('warns + opens no editor when no ticket carries the tag', async () => {
    mockPool.mockResolvedValue(pool({ workers: [slot({ worker: 'pw1', label: 'worker-1', state: 'idle' })] }));
    vi.mocked(getTicketPartition).mockResolvedValue([{ worker: 'pw1', label: 'worker-1', ticketIds: [], ticketNumbers: [] }]);
    await parallelizeTag('nope');
    expect(openPartitionEditor).not.toHaveBeenCalled();
  });
});

describe('submitWorkerPrompt (HS-9079)', () => {
  beforeEach(() => {
    vi.mocked(triggerChannelAndMarkBusy).mockReset();
    vi.mocked(confirmDialog).mockReset();
    vi.mocked(isChannelAlive).mockReturnValue(true);
    vi.mocked(isChannelBusy).mockReturnValue(false);
  });

  it('routes the wrapped directive to the main agent when idle (no confirm)', async () => {
    await submitWorkerPrompt('parallelize tag x');
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(triggerChannelAndMarkBusy).toHaveBeenCalledOnce();
    expect(vi.mocked(triggerChannelAndMarkBusy).mock.calls[0][0]).toContain('«parallelize tag x»');
  });

  it('no-ops on an empty instruction', async () => {
    await submitWorkerPrompt('   ');
    expect(triggerChannelAndMarkBusy).not.toHaveBeenCalled();
  });

  it('warns + does not send when the channel is not connected', async () => {
    vi.mocked(isChannelAlive).mockReturnValue(false);
    await submitWorkerPrompt('parallelize tag x');
    expect(triggerChannelAndMarkBusy).not.toHaveBeenCalled();
  });

  it('busy-aware: confirms before stacking on a mid-task agent; sends on confirm, not on cancel', async () => {
    vi.mocked(isChannelBusy).mockReturnValue(true);
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    await submitWorkerPrompt('parallelize tag x');
    expect(confirmDialog).toHaveBeenCalledOnce();
    expect(triggerChannelAndMarkBusy).not.toHaveBeenCalled();

    vi.mocked(confirmDialog).mockResolvedValueOnce(true);
    await submitWorkerPrompt('parallelize tag x');
    expect(triggerChannelAndMarkBusy).toHaveBeenCalledOnce();
  });
});
