import { describe, expect, it } from 'vitest';

import { formatInstallHelp, formatStatusText } from './dbRepairUI.js';

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
