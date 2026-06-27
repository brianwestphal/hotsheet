// @vitest-environment happy-dom
/**
 * HS-9107 — the "merge pending" badge's Review affordance. `reviewIntegrationBranch`
 * resolves the integration target from the live worker pool and opens Glassbox on
 * `target..<branch>`; `renderMergePendingBadge` is clickable only when the ticket
 * recorded its `integration_branch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Ticket } from './state.js';

const mocks = vi.hoisted(() => ({
  getWorkerPool: vi.fn(),
  reviewInGlassbox: vi.fn(() => Promise.resolve({ ok: true })),
  showToast: vi.fn(),
}));

vi.mock('../api/index.js', () => ({
  getWorkerPool: mocks.getWorkerPool,
  reviewInGlassbox: mocks.reviewInGlassbox,
}));
vi.mock('./toast.js', () => ({ showToast: mocks.showToast }));

const { reviewIntegrationBranch, renderMergePendingBadge } = await import('./integrationReview.js');

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: 1, ticket_number: 'HS-1', title: 'T', details: '', category: 'task', priority: 'default',
    status: 'completed', up_next: false, tags: '[]', notes: '', created_at: '', updated_at: '',
    completed_at: null, verified_at: null, deleted_at: null, last_read_at: null,
    pending_integration: true, integration_branch: 'hotsheet/worker-1', ...over,
  };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockClear();
  mocks.getWorkerPool.mockResolvedValue({ target: 'main', targetN: 0, workers: [] });
  mocks.reviewInGlassbox.mockResolvedValue({ ok: true });
});
afterEach(() => { document.body.innerHTML = ''; vi.clearAllMocks(); });

describe('reviewIntegrationBranch (HS-9107)', () => {
  it('opens Glassbox on target..branch using the pool target', async () => {
    await reviewIntegrationBranch('hotsheet/worker-1');
    expect(mocks.reviewInGlassbox).toHaveBeenCalledWith({ mode: 'range', from: 'main', to: 'hotsheet/worker-1' });
  });

  it('warns + no-ops when no branch is recorded', async () => {
    await reviewIntegrationBranch(null);
    expect(mocks.reviewInGlassbox).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalled();
  });

  it('warns + no-ops when the pool has no target branch', async () => {
    mocks.getWorkerPool.mockResolvedValue({ target: null, targetN: 0, workers: [] });
    await reviewIntegrationBranch('hotsheet/worker-1');
    expect(mocks.reviewInGlassbox).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalled();
  });

  it('warns (not throws) when the pool fetch fails', async () => {
    mocks.getWorkerPool.mockRejectedValue(new Error('boom'));
    await reviewIntegrationBranch('hotsheet/worker-1');
    expect(mocks.reviewInGlassbox).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalled();
  });
});

describe('renderMergePendingBadge (HS-9107)', () => {
  it('is a clickable Review affordance when integration_branch is set', async () => {
    const badge = renderMergePendingBadge(ticket({ integration_branch: 'hotsheet/worker-2' }));
    expect(badge.classList.contains('ticket-pending-merge-reviewable')).toBe(true);
    badge.click();
    await Promise.resolve(); await Promise.resolve();
    expect(mocks.reviewInGlassbox).toHaveBeenCalledWith({ mode: 'range', from: 'main', to: 'hotsheet/worker-2' });
  });

  it('is a passive badge (no review) when no branch is recorded', () => {
    const badge = renderMergePendingBadge(ticket({ integration_branch: null }));
    expect(badge.classList.contains('ticket-pending-merge-reviewable')).toBe(false);
    badge.click();
    expect(mocks.reviewInGlassbox).not.toHaveBeenCalled();
  });

  it('the click stops propagation so it does not also select the row', () => {
    const badge = renderMergePendingBadge(ticket());
    const onRowClick = vi.fn();
    const row = document.createElement('div');
    row.addEventListener('click', onRowClick);
    row.appendChild(badge);
    badge.click();
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
