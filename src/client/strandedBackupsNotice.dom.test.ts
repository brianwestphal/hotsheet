// @vitest-environment happy-dom
/**
 * HS-9536 — the Settings notice for backup roots left behind by a `backupDir`
 * change.
 *
 * The failure mode this guards is a user concluding their backups are gone (or
 * that an abandoned folder is the live one). Both directions are covered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listStrandedBackupRoots = vi.fn();
const revealStrandedBackupRoot = vi.fn();
vi.mock('../api/index.js', () => ({
  applyAiInstructions: vi.fn(), ensureSkills: vi.fn(), getFileSettings: vi.fn(),
  getTags: vi.fn(), updateSettings: vi.fn(),
  listStrandedBackupRoots: (...a: unknown[]): unknown => listStrandedBackupRoots(...a) as unknown,
  revealStrandedBackupRoot: (...a: unknown[]): unknown => revealStrandedBackupRoot(...a) as unknown,
}));

const { formatStrandedSize, renderStrandedBackups } = await import('./settingsDialog.js');

beforeEach(() => {
  document.body.innerHTML = '<div id="stranded-backups" hidden></div>';
  listStrandedBackupRoots.mockReset();
  revealStrandedBackupRoot.mockReset();
});
afterEach(() => { document.body.innerHTML = ''; });

const host = (): HTMLElement => document.getElementById('stranded-backups') as HTMLElement;

describe('formatStrandedSize', () => {
  it('never renders an unmeasurable folder as empty', () => {
    // "0 B" would tell a user their backups are gone. An unreachable folder is
    // the COMMON case here — it is often why the root was abandoned.
    expect(formatStrandedSize(null)).toContain('unknown');
    expect(formatStrandedSize(null)).not.toContain('0');
  });

  it('uses GB above a gigabyte and MB below', () => {
    expect(formatStrandedSize(2 * 1024 ** 3)).toBe('2.0 GB');
    expect(formatStrandedSize(300 * 1024 ** 2)).toBe('300 MB');
  });

  it('never rounds a non-empty folder down to 0 MB', () => {
    // A small-but-present folder reading "0 MB" is the same lie as above.
    expect(formatStrandedSize(1024)).toBe('1 MB');
  });
});

describe('renderStrandedBackups', () => {
  it('stays hidden when there is nothing stranded', async () => {
    listStrandedBackupRoots.mockResolvedValue([]);
    await renderStrandedBackups();
    expect(host().hidden).toBe(true);
  });

  it('stays hidden — and does not throw — when the request fails', async () => {
    // A housekeeping notice must never break the Settings dialog.
    listStrandedBackupRoots.mockRejectedValue(new Error('offline'));
    await expect(renderStrandedBackups()).resolves.toBeUndefined();
    expect(host().hidden).toBe(true);
  });

  it('shows the path, size and date for each stranded root', async () => {
    listStrandedBackupRoots.mockResolvedValue([
      { path: '/old/backups', sizeBytes: 1024 ** 3, newestBackupAt: '2026-06-29T00:00:00.000Z', tierCount: 3 },
    ]);
    await renderStrandedBackups();
    expect(host().hidden).toBe(false);
    expect(host().textContent).toContain('/old/backups');
    expect(host().textContent).toContain('1.0 GB');
    expect(host().textContent).toContain('2026-06-29');
  });

  it('offers Reveal and no destructive action', async () => {
    // The maintainer chose "inform only" partly BECAUSE a root that merely looks
    // abandoned can contain the live backups. No delete button, by design.
    listStrandedBackupRoots.mockResolvedValue([
      { path: '/old', sizeBytes: 1, newestBackupAt: null, tierCount: 1 },
    ]);
    await renderStrandedBackups();
    const labels = [...host().querySelectorAll('button')].map(b => b.textContent);
    expect(labels).toEqual(['Reveal']);
    expect(host().textContent.toLowerCase()).not.toContain('delete');
  });

  it('reveals the clicked root', async () => {
    listStrandedBackupRoots.mockResolvedValue([
      { path: '/old/a', sizeBytes: 1, newestBackupAt: null, tierCount: 1 },
      { path: '/old/b', sizeBytes: 1, newestBackupAt: null, tierCount: 1 },
    ]);
    await renderStrandedBackups();
    const buttons = [...host().querySelectorAll('button')];
    buttons[1].click();
    expect(revealStrandedBackupRoot).toHaveBeenCalledWith('/old/b');
  });

  it('clears the previous rows on re-render rather than appending', async () => {
    listStrandedBackupRoots.mockResolvedValue([{ path: '/x', sizeBytes: 1, newestBackupAt: null, tierCount: 1 }]);
    await renderStrandedBackups();
    await renderStrandedBackups();
    expect(host().querySelectorAll('button')).toHaveLength(1);
  });
});
