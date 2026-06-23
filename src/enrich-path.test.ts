import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { enrichProcessPath, mergePaths, resolveLoginShell } from './enrich-path.js';

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
    const exec = vi.fn().mockReturnValue('/Users/x/.local/bin:/opt/homebrew/bin:/usr/bin\n');

    enrichProcessPath({ exec: exec as never });

    expect(process.env.PATH).toBe('/Users/x/.local/bin:/opt/homebrew/bin:/usr/bin:/bin');
    expect(exec).toHaveBeenCalledWith('/bin/zsh', ['-ilc', 'printf %s "$PATH"'], expect.objectContaining({
      encoding: 'utf8',
      timeout: 2000,
    }));
  });

  it('is a no-op on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.SHELL = '/bin/zsh';
    process.env.PATH = 'C:\\Windows';
    const exec = vi.fn();

    enrichProcessPath({ exec: exec as never });

    expect(exec).not.toHaveBeenCalled();
    expect(process.env.PATH).toBe('C:\\Windows');
  });

  it('HS-8946 — falls back to the passwd-DB shell when $SHELL is unset (GUI launch)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    delete process.env.SHELL;
    process.env.PATH = '/usr/bin';
    const exec = vi.fn().mockReturnValue('/Users/x/.local/bin:/usr/bin\n');

    enrichProcessPath({ exec: exec as never, passwdShell: '/bin/zsh' });

    expect(exec).toHaveBeenCalledWith('/bin/zsh', ['-ilc', 'printf %s "$PATH"'], expect.objectContaining({ timeout: 2000 }));
    expect(process.env.PATH).toBe('/Users/x/.local/bin:/usr/bin');
  });

  it('HS-8946 — falls back to the platform default shell when $SHELL + passwd are both absent', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    delete process.env.SHELL;
    process.env.PATH = '/usr/bin';
    const exec = vi.fn().mockReturnValue('/opt/homebrew/bin:/usr/bin\n');

    enrichProcessPath({ exec: exec as never, passwdShell: null });

    expect(exec).toHaveBeenCalledWith('/bin/zsh', ['-ilc', 'printf %s "$PATH"'], expect.objectContaining({ timeout: 2000 }));
    expect(process.env.PATH).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('HS-8946 — falls back to a non-interactive login shell (-lc) when -ilc errors', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    process.env.PATH = '/usr/bin';
    const exec = vi.fn()
      .mockImplementationOnce(() => { throw new Error('no tty for -i'); })
      .mockReturnValueOnce('/a:/usr/bin\n');

    enrichProcessPath({ exec: exec as never, shell: '/bin/zsh' });

    expect(exec).toHaveBeenNthCalledWith(1, '/bin/zsh', ['-ilc', 'printf %s "$PATH"'], expect.anything());
    expect(exec).toHaveBeenNthCalledWith(2, '/bin/zsh', ['-lc', 'printf %s "$PATH"'], expect.anything());
    expect(process.env.PATH).toBe('/a:/usr/bin');
  });

  it('leaves PATH unchanged when the shell call throws (timeout, missing shell, etc.)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    process.env.SHELL = '/bin/zsh';
    process.env.PATH = '/usr/bin';
    const exec = vi.fn().mockImplementation(() => { throw new Error('ETIMEDOUT'); });

    enrichProcessPath({ exec: exec as never });

    expect(process.env.PATH).toBe('/usr/bin');
  });

  it('leaves PATH unchanged when the shell returns an empty PATH', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    process.env.SHELL = '/bin/zsh';
    process.env.PATH = '/usr/bin';
    const exec = vi.fn().mockReturnValue('   \n');

    enrichProcessPath({ exec: exec as never });

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
