// @vitest-environment happy-dom
// HS-8962 — worker-pool panel tests (docs/91 §91.5): tile rendering per state,
// drain wiring, and auto-cleanup of a stopped worker (close terminal + remove
// worktree + unregister).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  drainPoolWorker, getWorkerPool, removePoolWorker, removeWorktree, type WorkerSlotView,
} from '../api/index.js';
import { closeDynamicTerminal } from './terminalInstanceLifecycle.js';
import {
  closeWorkerPoolPanel, refreshPool, renderWorkerTile,
} from './workerPoolPanel.js';

vi.mock('../api/index.js', () => ({
  getWorkerPool: vi.fn(),
  launchWorker: vi.fn(),
  registerPoolWorker: vi.fn(),
  drainPoolWorker: vi.fn(),
  drainAllPoolWorkers: vi.fn(),
  removePoolWorker: vi.fn(),
  removeWorktree: vi.fn(),
}));
vi.mock('./toast.js', () => ({ showToast: vi.fn() }));
vi.mock('./terminalInstanceLifecycle.js', () => ({ closeDynamicTerminal: vi.fn() }));

const mockPool = vi.mocked(getWorkerPool);
const mockDrain = vi.mocked(drainPoolWorker);
const mockRemove = vi.mocked(removePoolWorker);
const mockRemoveWt = vi.mocked(removeWorktree);
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
  mockCloseTerm.mockResolvedValue(undefined);
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

describe('refreshPool (HS-8962)', () => {
  it('renders a tile per worker and wires Drain → drainPoolWorker', async () => {
    mockPool.mockResolvedValue({ targetN: 1, workers: [slot({ state: 'idle' })] });
    const body = document.createElement('div');
    await refreshPool(body);
    expect(body.querySelectorAll('.worker-tile')).toHaveLength(1);
    body.querySelector<HTMLButtonElement>('.worker-drain-btn')!.click();
    await flush();
    expect(mockDrain).toHaveBeenCalledWith({ worker: 'pw1' });
  });

  it('shows an empty state when there are no workers', async () => {
    mockPool.mockResolvedValue({ targetN: 0, workers: [] });
    const body = document.createElement('div');
    await refreshPool(body);
    expect(body.querySelector('.worker-pool-empty')).not.toBeNull();
  });

  it('auto-cleans a stopped worker: close terminal + remove worktree + unregister', async () => {
    // First load reports the worker stopped; the cleanup re-fetch reports it gone.
    mockPool.mockResolvedValueOnce({ targetN: 0, workers: [slot({ state: 'stopped' })] });
    mockPool.mockResolvedValue({ targetN: 0, workers: [] });
    const body = document.createElement('div');
    await refreshPool(body);
    await flush();
    expect(mockCloseTerm).toHaveBeenCalledWith('t-pw1', true);
    expect(mockRemoveWt).toHaveBeenCalledWith({ path: '/wt/pw1', force: true });
    expect(mockRemove).toHaveBeenCalledWith({ worker: 'pw1' });
  });

  it('renders an error state when the pool fetch fails', async () => {
    mockPool.mockRejectedValue(new Error('boom'));
    const body = document.createElement('div');
    await refreshPool(body);
    expect(body.querySelector('.worker-pool-error')?.textContent).toContain('boom');
  });
});
