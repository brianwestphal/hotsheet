// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorktree, listWorktrees, removeWorktree, type WorktreeInfo } from '../api/index.js';
import { confirmDialog } from './confirm.js';
import { openTerminalRunningCommand } from './terminal.js';
import {
  closeWorktreesPanel, openWorktreesPanel, refreshWorktreeList, renderWorktreeRow,
} from './worktreesPanel.js';

vi.mock('../api/index.js', () => ({
  listWorktrees: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));
vi.mock('./confirm.js', () => ({ confirmDialog: vi.fn() }));
vi.mock('./toast.js', () => ({ showToast: vi.fn() }));
vi.mock('./terminal.js', () => ({ openTerminalRunningCommand: vi.fn() }));

const mockList = vi.mocked(listWorktrees);
const mockCreate = vi.mocked(createWorktree);
const mockRemove = vi.mocked(removeWorktree);
const mockConfirm = vi.mocked(confirmDialog);
const mockOpenTerminal = vi.mocked(openTerminalRunningCommand);

const main: WorktreeInfo = { path: '/repo', branch: 'main', head: 'a1', isMain: true, authoritativeDataDir: null };
const follower: WorktreeInfo = { path: '/repo-worktrees/feat', branch: 'feat', head: 'b2', isMain: false, authoritativeDataDir: '/repo/.hotsheet' };

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});
afterEach(() => closeWorktreesPanel());

describe('renderWorktreeRow (HS-8938)', () => {
  it('main worktree: shows the main badge and no Remove button', () => {
    const row = renderWorktreeRow(main, () => { /* never called for main */ });
    expect(row.querySelector('.worktree-badge')?.textContent).toBe('main');
    expect(row.querySelector('.worktree-remove-btn')).toBeNull();
  });

  it('follower worktree: shows the follower badge + a wired Remove button', () => {
    const onRemove = vi.fn();
    const row = renderWorktreeRow(follower, onRemove);
    expect(row.querySelector('.worktree-badge-follower')).not.toBeNull();
    const btn = row.querySelector<HTMLButtonElement>('.worktree-remove-btn');
    expect(btn).not.toBeNull();
    btn!.click();
    expect(onRemove).toHaveBeenCalledWith(follower);
  });

  it('detached worktree renders "(detached)"', () => {
    const row = renderWorktreeRow({ ...follower, branch: null });
    expect(row.querySelector('.worktree-branch')?.textContent).toBe('(detached)');
  });
});

describe('refreshWorktreeList (HS-8938)', () => {
  it('renders a row per worktree', async () => {
    mockList.mockResolvedValue([main, follower]);
    const body = document.createElement('div');
    await refreshWorktreeList(body);
    expect(body.querySelectorAll('.worktree-row')).toHaveLength(2);
  });

  it('shows an empty state when there are no worktrees', async () => {
    mockList.mockResolvedValue([]);
    const body = document.createElement('div');
    await refreshWorktreeList(body);
    expect(body.querySelector('.worktrees-empty')).not.toBeNull();
  });

  it('shows an error state when the list call fails', async () => {
    mockList.mockRejectedValue(new Error('boom'));
    const body = document.createElement('div');
    await refreshWorktreeList(body);
    expect(body.querySelector('.worktrees-error')?.textContent).toContain('boom');
  });
});

describe('openWorktreesPanel (HS-8938)', () => {
  it('mounts the overlay and lists worktrees', async () => {
    mockList.mockResolvedValue([main]);
    openWorktreesPanel();
    expect(document.querySelector('.worktrees-overlay')).not.toBeNull();
    await flush();
    expect(document.querySelectorAll('.worktree-row')).toHaveLength(1);
  });

  it('create form submit calls createWorktree with the branch + newBranch', async () => {
    mockList.mockResolvedValue([main]);
    mockCreate.mockResolvedValue(follower);
    openWorktreesPanel();
    await flush();
    const input = document.querySelector<HTMLInputElement>('.worktrees-branch-input')!;
    const cb = document.querySelector<HTMLInputElement>('.worktrees-newbranch-cb')!;
    const form = document.querySelector<HTMLFormElement>('.worktrees-create')!;
    input.value = 'feature-z';
    cb.checked = true;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(mockCreate).toHaveBeenCalledWith({ branch: 'feature-z', newBranch: true });
  });

  it('remove flow: confirm → removeWorktree(force)', async () => {
    mockList.mockResolvedValue([main, follower]);
    mockConfirm.mockResolvedValue(true);
    mockRemove.mockResolvedValue({ ok: true });
    openWorktreesPanel();
    await flush();
    document.querySelector<HTMLButtonElement>('.worktree-remove-btn')!.click();
    await flush();
    expect(mockConfirm).toHaveBeenCalled();
    expect(mockRemove).toHaveBeenCalledWith({ path: follower.path, force: true });
  });

  it('remove flow: declining the confirm does not call removeWorktree', async () => {
    mockList.mockResolvedValue([main, follower]);
    mockConfirm.mockResolvedValue(false);
    openWorktreesPanel();
    await flush();
    document.querySelector<HTMLButtonElement>('.worktree-remove-btn')!.click();
    await flush();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('HS-8936 — "Open terminal" opens a claude terminal in the worktree cwd', async () => {
    mockList.mockResolvedValue([main, follower]);
    mockOpenTerminal.mockResolvedValue('term-1');
    openWorktreesPanel();
    await flush();
    // The follower row's terminal button (rows render terminal buttons for all).
    const btn = document.querySelectorAll<HTMLButtonElement>('.worktree-terminal-btn');
    // main + follower both get one; click the follower's (second).
    btn[btn.length - 1].click();
    await flush();
    expect(mockOpenTerminal).toHaveBeenCalledWith('claude', expect.stringContaining('feat'), follower.path);
    // opening a terminal closes the panel.
    expect(document.querySelector('.worktrees-overlay')).toBeNull();
  });

  it('Escape closes the overlay', async () => {
    mockList.mockResolvedValue([main]);
    openWorktreesPanel();
    await flush();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.worktrees-overlay')).toBeNull();
  });
});
