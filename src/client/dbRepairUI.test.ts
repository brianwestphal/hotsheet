// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bindDbRepairUI, formatInstallHelp, formatStatusText, refreshDbRepairStatus } from './dbRepairUI.js';

const h = vi.hoisted(() => ({
  getRecoveryStatus: vi.fn(),
  findWorkingBackup: vi.fn(),
  restoreBackup: vi.fn(() => Promise.resolve()),
  getResetwalAvailability: vi.fn(),
  runResetwal: vi.fn(() => Promise.resolve()),
  confirmDialog: vi.fn(() => Promise.resolve(false)),
}));
vi.mock('../api/index.js', () => ({
  getRecoveryStatus: h.getRecoveryStatus,
  findWorkingBackup: h.findWorkingBackup,
  restoreBackup: h.restoreBackup,
  getResetwalAvailability: h.getResetwalAvailability,
  runResetwal: h.runResetwal,
}));
vi.mock('./confirm.js', () => ({ confirmDialog: h.confirmDialog }));

/**
 * HS-7897: pure helpers for the Settings → Backups → Database Repair
 * panel. Both the install-help text (cross-platform per the user's
 * feedback caveat) and the status pill rely on small formatters that
 * are easy to break and easier to test.
 */
describe('formatStatusText (HS-7897)', () => {
  it('shows the healthy state when no marker', () => {
    const out = formatStatusText(null);
    expect(out.cls).toBe('is-healthy');
    expect(out.text).toMatch(/healthy/i);
  });

  it('shows the recovered state with a human timestamp when marker present', () => {
    const out = formatStatusText({
      corruptPath: '/tmp/db-corrupt-1',
      recoveredAt: '2026-04-27T12:00:00.000Z',
      errorMessage: 'PANIC: ...',
    });
    expect(out.cls).toBe('is-recovered');
    expect(out.text).toMatch(/recovery occurred/i);
    expect(out.text).toMatch(/banner/i);
  });
});

describe('formatInstallHelp (HS-7897)', () => {
  function avail(installInstructions: { description: string; command: string; url: string }) {
    return { available: false, path: null, platform: 'darwin', installInstructions };
  }

  it('mentions the platform description, the command, and the URL', () => {
    const help = formatInstallHelp(avail({
      description: 'macOS (via Homebrew)',
      command: 'brew install postgresql@17',
      url: 'https://www.postgresql.org/download/macosx/',
    }));
    expect(help).toMatch(/macOS \(via Homebrew\)/);
    expect(help).toMatch(/brew install postgresql@17/);
    expect(help).toMatch(/postgresql\.org\/download\/macosx/);
  });

  it('keeps multi-line install commands intact (Linux apt + dnf branches)', () => {
    const help = formatInstallHelp(avail({
      description: 'Linux',
      command: 'sudo apt install postgresql-17\nsudo dnf install postgresql17',
      url: 'https://www.postgresql.org/download/linux/',
    }));
    expect(help).toMatch(/apt install postgresql-17/);
    expect(help).toMatch(/dnf install postgresql17/);
    // Newline preserved so the dialog renders both lines verbatim.
    expect(help.split('\n').length).toBeGreaterThan(3);
  });

  it('handles the Windows EnterpriseDB hint without breaking', () => {
    const help = formatInstallHelp(avail({
      description: 'Windows',
      command: 'Download the EnterpriseDB installer for PostgreSQL 17',
      url: 'https://www.postgresql.org/download/windows/',
    }));
    expect(help).toMatch(/Windows/);
    expect(help).toMatch(/EnterpriseDB/);
    expect(help).toMatch(/postgresql\.org\/download\/windows/);
  });
});

// HS-9144 — the DOM half (status refresh + button wiring / find-working-backup).
describe('refreshDbRepairStatus', () => {
  beforeEach(() => { vi.clearAllMocks(); document.body.replaceChildren(); });

  it('returns quietly when the status element is absent', async () => {
    await expect(refreshDbRepairStatus()).resolves.toBeUndefined();
  });

  it('renders the healthy pill when there is no recovery marker', async () => {
    document.body.innerHTML = '<div id="db-repair-status"></div>';
    h.getRecoveryStatus.mockResolvedValue(null);
    await refreshDbRepairStatus();
    const el = document.getElementById('db-repair-status')!;
    expect(el.textContent).toMatch(/healthy/i);
    expect(el.classList.contains('is-healthy')).toBe(true);
  });

  it('renders the recovered pill when a marker exists', async () => {
    document.body.innerHTML = '<div id="db-repair-status"></div>';
    h.getRecoveryStatus.mockResolvedValue({ corruptPath: '/x', recoveredAt: '2026-01-01T00:00:00Z', errorMessage: 'e' });
    await refreshDbRepairStatus();
    const el = document.getElementById('db-repair-status')!;
    expect(el.classList.contains('is-recovered')).toBe(true);
  });

  it('shows an error message when the health check fails', async () => {
    document.body.innerHTML = '<div id="db-repair-status"></div>';
    h.getRecoveryStatus.mockRejectedValue(new Error('db down'));
    await refreshDbRepairStatus();
    expect(document.getElementById('db-repair-status')!.textContent).toMatch(/Could not load DB health: db down/);
  });
});

describe('bindDbRepairUI + find-working-backup', () => {
  beforeEach(() => { vi.clearAllMocks(); document.body.replaceChildren(); });

  function installPanel(): void {
    document.body.innerHTML = `
      <button id="db-repair-find-working-btn"></button>
      <button id="db-repair-pg-resetwal-btn"></button>
      <div id="db-repair-result"></div>`;
  }

  it('is a no-op when the buttons are absent', () => {
    expect(() => bindDbRepairUI()).not.toThrow();
  });

  it('shows "no working backup" when every tarball fails', async () => {
    installPanel();
    h.findWorkingBackup.mockResolvedValue(null);
    bindDbRepairUI();
    document.getElementById('db-repair-find-working-btn')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector('.db-repair-result-err')!.textContent).toMatch(/No working backup found/));
  });

  it('shows the found backup + a Restore button when one validates', async () => {
    installPanel();
    h.findWorkingBackup.mockResolvedValue({ filename: 'backup-3.tgz', tier: 'daily', ticketCount: 42, createdAt: '2026-01-01T00:00:00Z' });
    bindDbRepairUI();
    document.getElementById('db-repair-find-working-btn')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector('.db-repair-result-ok')!.textContent).toMatch(/backup-3\.tgz/));
    expect(document.getElementById('db-repair-restore-found-btn')).not.toBeNull();
  });

  it('shows a validation error when the backup scan throws', async () => {
    installPanel();
    h.findWorkingBackup.mockRejectedValue(new Error('scan boom'));
    bindDbRepairUI();
    document.getElementById('db-repair-find-working-btn')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector('.db-repair-result-err')!.textContent).toMatch(/Validation failed: scan boom/));
  });
});
