// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getPluginPendingCount } from '../api/index.js';
import { refreshSyncBadges } from './pluginSyncBadge.js';

// HS-8791 — the badge module only calls the typed `getPluginPendingCount`; mock it.
vi.mock('../api/index.js', () => ({ getPluginPendingCount: vi.fn() }));
const mockGet = vi.mocked(getPluginPendingCount);

function addSyncButton(pluginId: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'plugin-toolbar-btn';
  btn.setAttribute('data-plugin-action', 'sync');
  btn.setAttribute('data-plugin-id', pluginId);
  document.body.appendChild(btn);
  return btn;
}

describe('pluginSyncBadge (HS-8791)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mockGet.mockReset();
  });

  it('renders a badge with the total + a both-directions tooltip when out of sync', async () => {
    const btn = addSyncButton('github-issues');
    mockGet.mockResolvedValue({ toPull: 2, toPush: 1, total: 3, ok: true });
    await refreshSyncBadges();
    const badge = btn.querySelector('.plugin-sync-badge');
    expect(badge?.textContent).toBe('3');
    expect(badge?.getAttribute('title')).toContain('2 in');
    expect(badge?.getAttribute('title')).toContain('1 out');
  });

  it('shows no badge when fully in sync (total 0)', async () => {
    const btn = addSyncButton('github-issues');
    mockGet.mockResolvedValue({ toPull: 0, toPush: 0, total: 0, ok: true });
    await refreshSyncBadges();
    expect(btn.querySelector('.plugin-sync-badge')).toBeNull();
  });

  it('removes an existing badge when the count drops to 0', async () => {
    const btn = addSyncButton('github-issues');
    mockGet.mockResolvedValueOnce({ toPull: 5, toPush: 0, total: 5, ok: true });
    await refreshSyncBadges();
    expect(btn.querySelector('.plugin-sync-badge')?.textContent).toBe('5');
    mockGet.mockResolvedValueOnce({ toPull: 0, toPush: 0, total: 0, ok: true });
    await refreshSyncBadges();
    expect(btn.querySelector('.plugin-sync-badge')).toBeNull();
  });

  it('caps the display at 99+', async () => {
    const btn = addSyncButton('github-issues');
    mockGet.mockResolvedValue({ toPull: 150, toPush: 0, total: 150, ok: true });
    await refreshSyncBadges();
    expect(btn.querySelector('.plugin-sync-badge')?.textContent).toBe('99+');
  });

  it('clears the badge when the backend reports not-ok (disabled/unconfigured)', async () => {
    const btn = addSyncButton('github-issues');
    mockGet.mockResolvedValue({ toPull: 0, toPush: 0, total: 0, ok: false });
    await refreshSyncBadges();
    expect(btn.querySelector('.plugin-sync-badge')).toBeNull();
  });

  it('leaves an existing badge unchanged on a transient fetch error', async () => {
    const btn = addSyncButton('github-issues');
    mockGet.mockResolvedValueOnce({ toPull: 4, toPush: 0, total: 4, ok: true });
    await refreshSyncBadges();
    expect(btn.querySelector('.plugin-sync-badge')?.textContent).toBe('4');
    mockGet.mockRejectedValueOnce(new Error('network'));
    await refreshSyncBadges();
    expect(btn.querySelector('.plugin-sync-badge')?.textContent).toBe('4');
  });
});
