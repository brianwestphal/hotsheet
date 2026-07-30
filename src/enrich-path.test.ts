import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { enrichProcessPath, extractMarkedPath, mergePaths, resolveLoginShell } from './enrich-path.js';

// HS-9509 — the probe moved from `execFileSync` (returns stdout, throws on failure)
// to `spawnSync` (returns a result object) so it can read the child's pid and reap
// its whole process group. These shape the fakes accordingly.
function spawnOk(pathValue: string) {
  // HS-9512 — the probe reads only what is between the markers, so fakes must
  // speak the same protocol the real shell is asked to.
  return marked(`__HOTSHEET_PATH_BEGIN__${pathValue.trim()}__HOTSHEET_PATH_END__`);
}
/** A raw stdout fake, for asserting what the probe does with unmarked / noisy output. */
function marked(stdout: string) {
  return { pid: 0, status: 0, signal: null, stdout, stderr: '', output: [] };
}
function spawnFail(message: string) {
  return { pid: 0, status: null, signal: null, stdout: '', stderr: '', output: [], error: new Error(message) };
}


describe('mergePaths', () => {
  it('prepends entries the shell PATH has and the current PATH does not', () => {
    const out = mergePaths('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin');
    expect(out).toBe('/opt/homebrew/bin:/usr/bin:/bin');
  });

  it('preserves the shell PATH ordering for new entries', () => {
    const out = mergePaths('/usr/bin', '/a:/b:/c:/usr/bin');
    expect(out).toBe('/a:/b:/c:/usr/bin');
  });

  it('drops duplicates within the shell PATH', () => {
    const out = mergePaths('/usr/bin', '/a:/a:/b');
    expect(out).toBe('/a:/b:/usr/bin');
  });

  it('drops empty / whitespace-only segments', () => {
    const out = mergePaths('/usr/bin', '/a::/b:   :/c');
    expect(out).toBe('/a:/b:/c:/usr/bin');
  });

  it('returns the current PATH unchanged when shell PATH adds nothing new', () => {
    const out = mergePaths('/a:/b:/c', '/a:/b');
    expect(out).toBe('/a:/b:/c');
  });

  it('handles an empty current PATH', () => {
    const out = mergePaths('', '/a:/b');
    expect(out).toBe('/a:/b');
  });
});

describe('enrichProcessPath', () => {
  let originalPath: string | undefined;
  let originalShell: string | undefined;
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
    originalShell = process.env.SHELL;
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalShell === undefined) delete process.env.SHELL; else process.env.SHELL = originalShell;
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    vi.restoreAllMocks();
  });

  it('prepends the login-shell PATH entries to process.env.PATH', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    process.env.SHELL = '/bin/zsh';
    process.env.PATH = '/usr/bin:/bin';
    const spawn = vi.fn().mockReturnValue(spawnOk('/Users/x/.local/bin:/opt/homebrew/bin:/usr/bin\n'));

    enrichProcessPath({ spawn: spawn as never });

    expect(process.env.PATH).toBe('/Users/x/.local/bin:/opt/homebrew/bin:/usr/bin:/bin');
    expect(spawn).toHaveBeenCalledWith('/bin/zsh', ['-ilc', expect.stringContaining('"$PATH"')], expect.objectContaining({
      encoding: 'utf8',
      timeout: 2000,
    }));
  });

  it('is a no-op on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.SHELL = '/bin/zsh';
    process.env.PATH = 'C:\\Windows';
    const spawn = vi.fn();

    enrichProcessPath({ spawn: spawn as never });

    expect(spawn).not.toHaveBeenCalled();
    expect(process.env.PATH).toBe('C:\\Windows');
  });

  it('HS-8946 — falls back to the passwd-DB shell when $SHELL is unset (GUI launch)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    delete process.env.SHELL;
    process.env.PATH = '/usr/bin';
    const spawn = vi.fn().mockReturnValue(spawnOk('/Users/x/.local/bin:/usr/bin\n'));

    enrichProcessPath({ spawn: spawn as never, passwdShell: '/bin/zsh' });

    expect(spawn).toHaveBeenCalledWith('/bin/zsh', ['-ilc', expect.stringContaining('"$PATH"')], expect.objectContaining({ timeout: 2000 }));
    expect(process.env.PATH).toBe('/Users/x/.local/bin:/usr/bin');
  });

  it('HS-8946 — falls back to the platform default shell when $SHELL + passwd are both absent', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    delete process.env.SHELL;
    process.env.PATH = '/usr/bin';
    const spawn = vi.fn().mockReturnValue(spawnOk('/opt/homebrew/bin:/usr/bin\n'));

    enrichProcessPath({ spawn: spawn as never, passwdShell: null });

    expect(spawn).toHaveBeenCalledWith('/bin/zsh', ['-ilc', expect.stringContaining('"$PATH"')], expect.objectContaining({ timeout: 2000 }));
    expect(process.env.PATH).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('HS-8946 — falls back to a non-interactive login shell (-lc) when -ilc errors', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    process.env.PATH = '/usr/bin';
    const spawn = vi.fn()
      .mockImplementationOnce(() => spawnFail('no tty for -i'))
      .mockReturnValueOnce(spawnOk('/a:/usr/bin\n'));

    enrichProcessPath({ spawn: spawn as never, shell: '/bin/zsh' });

    expect(spawn).toHaveBeenNthCalledWith(1, '/bin/zsh', ['-ilc', expect.stringContaining('"$PATH"')], expect.anything());
    expect(spawn).toHaveBeenNthCalledWith(2, '/bin/zsh', ['-lc', expect.stringContaining('"$PATH"')], expect.anything());
    expect(process.env.PATH).toBe('/a:/usr/bin');
  });

  it('HS-9391 — kills a timed-out probe with SIGKILL, which an interactive shell cannot ignore', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    process.env.PATH = '/usr/bin';
    const spawn = vi.fn()
      .mockImplementationOnce(() => spawnFail('timed out'))
      .mockReturnValueOnce(spawnOk('/a:/usr/bin\n'));

    enrichProcessPath({ spawn: spawn as never, shell: '/bin/zsh' });

    // BOTH attempts, not just `-ilc`: `-lc` still runs the login rc files, which can
    // themselves block, and a fallback that can hang forever is no fallback.
    for (const call of [1, 2]) {
      expect(spawn).toHaveBeenNthCalledWith(call, '/bin/zsh', expect.anything(),
        expect.objectContaining({ killSignal: 'SIGKILL' }));
    }
  });

  it('HS-9391 — SIGKILL genuinely enforces the timeout on a SIGTERM-ignoring child', () => {
    if (process.platform === 'win32') return;
    // The claim the fix rests on, exercised against a REAL process rather than asserted
    // in a comment: `trap "" TERM` is what an interactive shell effectively does, and it
    // is why the default killSignal left `execFileSync` blocked forever. Only the SIGKILL
    // side is run — asserting the SIGTERM side hangs would mean writing a test that hangs.
    const started = Date.now();
    expect(() => execFileSync('/bin/sh', ['-c', 'trap "" TERM; sleep 30'], {
      timeout: 500,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
    })).toThrow();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('leaves PATH unchanged when the shell call throws (timeout, missing shell, etc.)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    process.env.SHELL = '/bin/zsh';
    process.env.PATH = '/usr/bin';
    const spawn = vi.fn().mockImplementation(() => spawnFail('ETIMEDOUT'));

    enrichProcessPath({ spawn: spawn as never });

    expect(process.env.PATH).toBe('/usr/bin');
  });

  it('leaves PATH unchanged when the shell returns an empty PATH', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    process.env.SHELL = '/bin/zsh';
    process.env.PATH = '/usr/bin';
    const spawn = vi.fn().mockReturnValue(spawnOk('   \n'));

    enrichProcessPath({ spawn: spawn as never });

    expect(process.env.PATH).toBe('/usr/bin');
  });
});

describe('resolveLoginShell (HS-8946)', () => {
  let originalPlatform: PropertyDescriptor | undefined;
  beforeEach(() => { originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform'); });
  afterEach(() => { if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform); });

  it('prefers $SHELL when set', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(resolveLoginShell({ env: { SHELL: '/opt/homebrew/bin/fish' }, passwdShell: '/bin/zsh' })).toBe('/opt/homebrew/bin/fish');
  });

  it('falls back to the passwd-DB shell when $SHELL is unset', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(resolveLoginShell({ env: {}, passwdShell: '/bin/bash' })).toBe('/bin/bash');
  });

  it('falls back to /bin/zsh on macOS when $SHELL + passwd are absent', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(resolveLoginShell({ env: {}, passwdShell: null })).toBe('/bin/zsh');
  });

  it('falls back to /bin/bash on non-macOS when $SHELL + passwd are absent', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(resolveLoginShell({ env: {}, passwdShell: null })).toBe('/bin/bash');
  });

  it('ignores a nologin/false passwd shell and uses the default', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(resolveLoginShell({ env: {}, passwdShell: '/usr/bin/false' })).toBe('/bin/zsh');
    expect(resolveLoginShell({ env: {}, passwdShell: '/sbin/nologin' })).toBe('/bin/zsh');
  });

  it('ignores an empty/whitespace $SHELL', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(resolveLoginShell({ env: { SHELL: '   ' }, passwdShell: '/bin/bash' })).toBe('/bin/bash');
  });

  it('returns null on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(resolveLoginShell({ env: { SHELL: '/bin/zsh' }, passwdShell: '/bin/zsh' })).toBeNull();
  });
});

// HS-9512 — the probe runs an INTERACTIVE shell, and interactive shells print
// startup chatter to stdout. Treating the whole stream as the PATH corrupted it.
describe('HS-9512 — shell banner output must not reach PATH', () => {
  let originalPath: string | undefined;
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });
  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  // The exact stdout captured from the maintainer's machine on 2026-07-30, which is
  // what made this a real bug rather than a hypothetical one. Before the fix this
  // produced PATH entries "Restored session", " Thu Jul 30 16", "21", and a fourth
  // that fused the banner tail onto /Users/x/.local/bin so it stopped resolving.
  const APPLE_TERMINAL_BANNER = 'Restored session: Thu Jul 30 16:21:23 PST 2026\n';

  it('discards the macOS Terminal "Restored session" banner and keeps the first entry intact', () => {
    process.env.PATH = '/usr/bin';
    const realPath = '/Users/x/.local/bin:/opt/homebrew/bin:/usr/bin';
    const spawn = vi.fn().mockReturnValue(
      marked(`${APPLE_TERMINAL_BANNER}__HOTSHEET_PATH_BEGIN__${realPath}__HOTSHEET_PATH_END__`));

    enrichProcessPath({ spawn: spawn as never, shell: '/bin/zsh' });

    expect(process.env.PATH).toBe('/Users/x/.local/bin:/opt/homebrew/bin:/usr/bin');
    // The specific regression: the first real entry must survive as its own entry.
    const entries = process.env.PATH.split(':');
    expect(entries).toContain('/Users/x/.local/bin');
    // And nothing from the banner may appear anywhere.
    expect(process.env.PATH).not.toContain('Restored');
    expect(process.env.PATH).not.toContain('PST');
    for (const entry of entries) {
      expect(entry).not.toMatch(/\s/); // no entry carries whitespace
      expect(entry.startsWith('/')).toBe(true);
    }
  });

  it('asks the shell for a marked value in the first place', () => {
    process.env.PATH = '/usr/bin';
    const spawn = vi.fn().mockReturnValue(marked('__HOTSHEET_PATH_BEGIN__/a__HOTSHEET_PATH_END__'));

    enrichProcessPath({ spawn: spawn as never, shell: '/bin/zsh' });

    const args: unknown = spawn.mock.calls[0][1];
    const script = Array.isArray(args) ? String(args[1]) : '';
    expect(script).toContain('__HOTSHEET_PATH_BEGIN__');
    expect(script).toContain('__HOTSHEET_PATH_END__');
    // Single-quoted format string: the shell must expand $PATH and nothing else.
    expect(script).toContain('"$PATH"');
  });

  it('accepts unmarked output only when it cannot be carrying chatter', () => {
    process.env.PATH = '/usr/bin';
    // Clean, whitespace-free: a shell that dropped the markers but answered honestly.
    const clean = vi.fn().mockReturnValue(marked('/opt/clean/bin:/usr/bin'));
    enrichProcessPath({ spawn: clean as never, shell: '/bin/zsh' });
    expect(process.env.PATH).toBe('/opt/clean/bin:/usr/bin');
  });

  it('refuses unmarked output that contains chatter rather than corrupting PATH', () => {
    process.env.PATH = '/usr/bin';
    // Unmarked AND noisy -> "no answer". Degrading to no enrichment beats garbage.
    const noisy = vi.fn().mockReturnValue(marked(`${APPLE_TERMINAL_BANNER}/Users/x/.local/bin:/usr/bin`));
    enrichProcessPath({ spawn: noisy as never, shell: '/bin/zsh' });
    expect(process.env.PATH).toBe('/usr/bin'); // unchanged
  });

  it('drops non-absolute segments the shell contributes (defense in depth)', () => {
    expect(mergePaths('/usr/bin', 'relative/dir:/opt/ok:  :/usr/bin')).toBe('/opt/ok:/usr/bin');
  });

  describe('extractMarkedPath', () => {
    it('returns the value between markers', () => {
      expect(extractMarkedPath('noise__HOTSHEET_PATH_BEGIN__/a:/b__HOTSHEET_PATH_END__')).toBe('/a:/b');
    });
    it('returns null when a marker is missing', () => {
      expect(extractMarkedPath('/a:/b')).toBeNull();
      expect(extractMarkedPath('__HOTSHEET_PATH_BEGIN__/a:/b')).toBeNull();
    });
    it('uses the LAST begin marker, so an rc file echoing one cannot spoof the value', () => {
      const out = '__HOTSHEET_PATH_BEGIN__/spoofed__HOTSHEET_PATH_BEGIN__/real__HOTSHEET_PATH_END__';
      expect(extractMarkedPath(out)).toBe('/real');
    });
  });
});
