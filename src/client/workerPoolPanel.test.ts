// @vitest-environment happy-dom
// HS-8962 + HS-8971 — worker-pool panel tests (docs/91 §91.5): tile rendering per
// state, the target-N stepper + reconcile (add/drain toward N), drain wiring, and
// auto-cleanup of a stopped worker (close terminal + remove worktree + unregister).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  drainPoolWorker, getWorkerPool, launchWorker, registerPoolWorker,
  removePoolWorker, removeWorktree, setPoolTarget, type WorkerSlotView,
} from '../api/index.js';
import { closeDynamicTerminal } from './terminalInstanceLifecycle.js';
import {
  closeWorkerPoolPanel, refreshPool, renderPoolControls, renderWorkerTile,
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
}));
vi.mock('./toast.js', () => ({ showToast: vi.fn() }));
vi.mock('./terminalInstanceLifecycle.js', () => ({ closeDynamicTerminal: vi.fn() }));
vi.mock('./terminal.js', () => ({ openTerminalRunningCommand: vi.fn().mockResolvedValue('term-new') }));

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
  terminalId: 't-pw1', state: 'idle', currentTicket: null, ...over,
});

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '';
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
});

describe('renderPoolControls — target stepper (HS-8971)', () => {
  it('shows the target + running count and wires the steppers', () => {
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

  it('disables − at target 0 and Drain all when nothing is running', () => {
    const el = document.createElement('div');
    renderPoolControls(el, 0, 0, vi.fn(), vi.fn());
    expect(el.querySelector<HTMLButtonElement>('.worker-pool-step-down')!.disabled).toBe(true);
    expect(el.querySelector<HTMLButtonElement>('.worker-pool-drain-all')!.disabled).toBe(true);
  });
});

describe('refreshPool (HS-8962)', () => {
  it('renders a tile per worker and wires Drain → drainPoolWorker + lowers target', async () => {
    mockPool.mockResolvedValue({ targetN: 1, workers: [slot({ state: 'idle' })] });
    const body = document.createElement('div');
    await refreshPool(body);
    expect(body.querySelectorAll('.worker-tile')).toHaveLength(1);
    body.querySelector<HTMLButtonElement>('.worker-drain-btn')!.click();
    await flush();
    expect(mockDrain).toHaveBeenCalledWith({ worker: 'pw1' });
    expect(mockSetTarget).toHaveBeenCalledWith({ targetN: 0 }); // drained one → target 1→0
  });

  it('shows an empty state when there are no workers', async () => {
    mockPool.mockResolvedValue({ targetN: 0, workers: [] });
    const body = document.createElement('div');
    await refreshPool(body);
    expect(body.querySelector('.worker-pool-empty')).not.toBeNull();
  });

  it('auto-cleans a stopped worker: close terminal + remove worktree + unregister', async () => {
    mockPool.mockResolvedValueOnce({ targetN: 0, workers: [slot({ state: 'stopped' })] });
    mockPool.mockResolvedValue({ targetN: 0, workers: [] });
    const body = document.createElement('div');
    await refreshPool(body);
    await flush();
    expect(mockCloseTerm).toHaveBeenCalledWith('t-pw1', true);
    expect(mockRemoveWt).toHaveBeenCalledWith({ path: '/wt/pw1', force: true });
    expect(mockRemove).toHaveBeenCalledWith({ worker: 'pw1' });
  });

  it('reconcile adds a worker when the live count is below target (HS-8971)', async () => {
    // Target 1 but no live workers → reconcile launches one; then the pool reports it.
    mockPool.mockResolvedValueOnce({ targetN: 1, workers: [] });
    mockPool.mockResolvedValue({ targetN: 1, workers: [slot({ worker: 'pw2', label: 'worker-2', state: 'idle' })] });
    const body = document.createElement('div');
    await refreshPool(body);
    await flush();
    expect(mockLaunch).toHaveBeenCalledWith({ branch: 'hotsheet/worker-1' });
    expect(mockRegister).toHaveBeenCalled();
  });

  it('reconcile drains the surplus (idle first) when the live count exceeds target', async () => {
    mockPool.mockResolvedValue({
      targetN: 1,
      workers: [slot({ worker: 'a', label: 'worker-1', state: 'working' }), slot({ worker: 'b', label: 'worker-2', state: 'idle' })],
    });
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
