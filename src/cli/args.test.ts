import { homedir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { globalHotsheetDir } from '../global-dir.js';
import { isTestMode, setTestMode } from '../test-mode.js';
import { parseArgs, printUsage, TEST_MODE_PORT } from './args.js';

// HS-8921 — `--test` turnkey isolation. `parseArgs` here has two real side
// effects worth asserting AND cleaning up between cases: it sets
// `process.env.HOTSHEET_HOME` (when unset) and flips the process-global test
// mode. Save/restore both so cases don't leak into each other or the real env.
describe('parseArgs --test (HS-8921)', () => {
  const SAVED_HOME = process.env.HOTSHEET_HOME;

  /** Build a process.argv-shaped array (parseArgs slices off the first two). */
  const argv = (...flags: string[]): string[] => ['node', 'cli.js', ...flags];

  beforeEach(() => {
    delete process.env.HOTSHEET_HOME;
    setTestMode(false);
  });

  afterEach(() => {
    if (SAVED_HOME === undefined) delete process.env.HOTSHEET_HOME;
    else process.env.HOTSHEET_HOME = SAVED_HOME;
    setTestMode(false);
  });

  it('defaults: no --test ⇒ test off, port 4174, isTestMode() false', () => {
    const parsed = parseArgs(argv());
    expect(parsed?.test).toBe(false);
    expect(parsed?.port).toBe(4174);
    expect(isTestMode()).toBe(false);
    // It must NOT touch HOTSHEET_HOME when --test isn't passed.
    expect(process.env.HOTSHEET_HOME).toBeUndefined();
  });

  it('--test ⇒ port 4274, test on, sandbox data-dir under ~/.hotsheet-test, isTestMode() true', () => {
    const parsed = parseArgs(argv('--test'));
    expect(parsed?.test).toBe(true);
    expect(parsed?.port).toBe(TEST_MODE_PORT);
    expect(isTestMode()).toBe(true);
    // HOTSHEET_HOME was set to the stable isolated dir...
    expect(process.env.HOTSHEET_HOME).toBe(join(homedir(), '.hotsheet-test'));
    // ...and the sandbox data-dir resolves under it.
    expect(parsed?.dataDir).toBe(join(globalHotsheetDir(), 'sandbox-project', '.hotsheet'));
  });

  it('--test with explicit --port keeps the explicit port (order-independent)', () => {
    expect(parseArgs(argv('--test', '--port', '9999'))?.port).toBe(9999);
    setTestMode(false);
    expect(parseArgs(argv('--port', '9999', '--test'))?.port).toBe(9999);
  });

  it('--test with explicit --data-dir keeps the explicit data-dir', () => {
    const parsed = parseArgs(argv('--test', '--data-dir', '/tmp/my-project/.hotsheet'));
    expect(parsed?.dataDir).toBe('/tmp/my-project/.hotsheet');
  });

  it('--test respects a pre-set HOTSHEET_HOME (does not override it)', () => {
    process.env.HOTSHEET_HOME = '/custom/home';
    const parsed = parseArgs(argv('--test'));
    expect(process.env.HOTSHEET_HOME).toBe('/custom/home');
    expect(parsed?.dataDir).toBe(join('/custom/home', 'sandbox-project', '.hotsheet'));
  });

  it('--test treats an empty/whitespace HOTSHEET_HOME as unset', () => {
    process.env.HOTSHEET_HOME = '   ';
    const parsed = parseArgs(argv('--test'));
    expect(process.env.HOTSHEET_HOME).toBe(join(homedir(), '.hotsheet-test'));
    expect(parsed?.dataDir).toBe(join(homedir(), '.hotsheet-test', 'sandbox-project', '.hotsheet'));
  });
});

describe('parseArgs --bind (HS-7940)', () => {
  const argv = (...flags: string[]): string[] => ['node', 'cli.js', ...flags];

  it('defaults bind to undefined when not passed (server falls back to config → 127.0.0.1)', () => {
    expect(parseArgs(argv())?.bind).toBeUndefined();
  });

  it('parses --bind <address>', () => {
    expect(parseArgs(argv('--bind', '0.0.0.0'))?.bind).toBe('0.0.0.0');
    expect(parseArgs(argv('--bind', '192.168.1.10'))?.bind).toBe('192.168.1.10');
  });
});

describe('parseArgs --server (HS-9163)', () => {
  const argv = (...flags: string[]): string[] => ['node', 'cli.js', ...flags];
  // The error path calls process.exit; silence + trap it for the invalid case.
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${String(code)}`); }) as never);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('defaults server to null (today\'s behavior: server + auto-opened client)', () => {
    const p = parseArgs(argv())!;
    expect(p.server).toBeNull();
    expect(p.noOpen).toBe(false);
  });

  it('--server localhost ⇒ server-only (noOpen), bind stays loopback default (undefined)', () => {
    const p = parseArgs(argv('--server', 'localhost'))!;
    expect(p.server).toBe('localhost');
    expect(p.noOpen).toBe(true);
    expect(p.bind).toBeUndefined();
  });

  it('--server remote-access ⇒ server-only + defaults bind to 0.0.0.0', () => {
    const p = parseArgs(argv('--server', 'remote-access'))!;
    expect(p.server).toBe('remote-access');
    expect(p.noOpen).toBe(true);
    expect(p.bind).toBe('0.0.0.0');
  });

  it('--server remote-access --bind <ip> ⇒ explicit --bind overrides the 0.0.0.0 default', () => {
    expect(parseArgs(argv('--server', 'remote-access', '--bind', '192.168.1.10'))?.bind).toBe('192.168.1.10');
    // Order-independent.
    expect(parseArgs(argv('--bind', '192.168.1.10', '--server', 'remote-access'))?.bind).toBe('192.168.1.10');
  });

  it('--server localhost does NOT expose (bind stays undefined even alongside other flags)', () => {
    expect(parseArgs(argv('--server', 'localhost', '--port', '8080'))?.bind).toBeUndefined();
  });

  it.each([['--server'], ['--server', 'public'], ['--server', '--bind']])('exits 1 on a missing/invalid mode: %s', (...flags: string[]) => {
    expect(() => parseArgs(argv(...flags))).toThrow('exit:1');
  });
});

describe('parseArgs — flags + valid values', () => {
  const argv = (...flags: string[]): string[] => ['node', 'cli.js', ...flags];

  it('defaults are sane with no flags', () => {
    const p = parseArgs(argv())!;
    expect(p).toMatchObject({ port: 4174, demo: null, forceUpdateCheck: false, noOpen: false, strictPort: false, replace: false, close: false, force: false, list: false, test: false, server: null });
    expect(p.bind).toBeUndefined();
  });

  it('parses every boolean flag', () => {
    const p = parseArgs(argv('--no-open', '--strict-port', '--replace', '--close', '--force', '--list', '--check-for-updates'))!;
    expect(p).toMatchObject({ noOpen: true, strictPort: true, replace: true, close: true, force: true, list: true, forceUpdateCheck: true });
  });

  it('parses --port and --demo:N', () => {
    expect(parseArgs(argv('--port', '8080'))?.port).toBe(8080);
    expect(parseArgs(argv('--demo:3'))?.demo).toBe(3);
  });
});

describe('parseArgs — error + usage exits', () => {
  const argv = (...flags: string[]): string[] => ['node', 'cli.js', ...flags];
  let exitMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Make process.exit throw so the test stops at the exit call + can assert the code.
    exitMock = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${String(code)}`); }) as never);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([
    ['--demo:0'], ['--demo:abc'], ['--port', 'notnum'], ['--bind'], ['--bind', '--force'], ['--totally-unknown'],
  ])('exits 1 on invalid input: %s', (...flags: string[]) => {
    expect(() => parseArgs(argv(...flags))).toThrow('exit:1');
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it.each([['--help'], ['-h']])('prints usage and exits 0 on %s', (flag: string) => {
    expect(() => parseArgs(argv(flag))).toThrow('exit:0');
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it('printUsage runs without throwing', () => {
    expect(() => printUsage()).not.toThrow();
  });
});
