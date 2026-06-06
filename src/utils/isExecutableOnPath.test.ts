/**
 * HS-8785 — the executable probe must search common install locations beyond
 * `process.env.PATH`, so a GUI-launched app (minimal launchd PATH) still finds a
 * Homebrew/`/usr/local/bin`/official-installer CLI like `claude`.
 */
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { extraSearchDirs, findExecutable } from './isExecutableOnPath.js';

describe('findExecutable (HS-8785)', () => {
  it('finds an executable present in one of the dirs', () => {
    const found = findExecutable('claude', ['/usr/bin', '/opt/homebrew/bin'], {
      win: false,
      fileExists: p => p === '/opt/homebrew/bin/claude',
    });
    expect(found).toBe(true);
  });

  it('returns false when the executable is in none of the dirs', () => {
    const found = findExecutable('claude', ['/usr/bin', '/bin'], { win: false, fileExists: () => false });
    expect(found).toBe(false);
  });

  it('skips empty dir segments (trailing PATH delimiter)', () => {
    const calls: string[] = [];
    findExecutable('claude', ['', '/usr/local/bin'], {
      win: false,
      fileExists: p => { calls.push(p); return false; },
    });
    expect(calls).toEqual(['/usr/local/bin/claude']); // the '' segment was skipped
  });

  it('tries Windows executable extensions', () => {
    const found = findExecutable('claude', ['C:/bin'], {
      win: true,
      fileExists: p => p === join('C:/bin', 'claude.cmd'),
    });
    expect(found).toBe(true);
  });
});

describe('extraSearchDirs (HS-8785)', () => {
  it('includes the common GUI-PATH-missing install locations on unix', () => {
    if (process.platform === 'win32') return; // unix-only behavior
    const dirs = extraSearchDirs();
    expect(dirs).toContain('/usr/local/bin');
    expect(dirs).toContain('/opt/homebrew/bin');
    // the official Claude Code installer location
    expect(dirs.some(d => d.endsWith('/.claude/local'))).toBe(true);
  });
});
