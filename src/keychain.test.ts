/**
 * HS-9019 — `isKeychainAvailable()` on Linux must verify the Secret Service
 * actually works (a store→lookup→clear round-trip), not just that `secret-tool`
 * is installed: a headless box often has the binary but no running keyring
 * daemon, which used to pass the check then fail at first write.
 *
 * We mock `child_process.execFile` to simulate three machines: binary absent,
 * binary present but daemon down, and a fully working keyring.
 */
import type * as NodeOs from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let plat = 'linux';
vi.mock('os', async (orig) => {
  const actual = await orig<typeof NodeOs>();
  return { ...actual, platform: () => plat };
});

// Simulated environment knobs the mock reads.
let binaryPresent = true;
let daemonUp = true;
const secrets = new Map<string, string>();

vi.mock('child_process', () => ({
  execFile: vi.fn((cmd: string, args: string[], _opts: unknown, cb: (err: unknown, stdout: string) => void) => {
    const fail = (): void => cb(Object.assign(new Error('fail'), { status: 1 }), '');
    if (cmd === 'which') {
      return binaryPresent ? cb(null, '/usr/bin/secret-tool') : fail();
    }
    if (cmd === 'secret-tool') {
      const op = args[0];
      // `service`/`account` appear as keyword+value pairs at different offsets
      // for store vs lookup/clear — scan for them rather than assume positions.
      const after = (kw: string): string => { const i = args.indexOf(kw); return i >= 0 ? args[i + 1] : ''; };
      const key = `${after('service')}/${after('account')}`;
      if (!daemonUp) {
        // A returned proc is needed for the `store` (stdin) path.
        const proc = { stdin: { write: () => {}, end: () => {} } };
        // Defer the failing callback so `proc.stdin` is wired first.
        queueMicrotask(() => fail());
        return proc;
      }
      if (op === 'store') {
        const proc = { stdin: { _buf: '', write(s: string) { this._buf += s; }, end() { secrets.set(key, this._buf); } } };
        queueMicrotask(() => cb(null, ''));
        return proc;
      }
      if (op === 'lookup') return cb(null, secrets.get(key) ?? '');
      if (op === 'clear') { secrets.delete(key); return cb(null, ''); }
    }
    return cb(null, '');
  }),
}));

const { isKeychainAvailable, __resetKeychainAvailabilityCacheForTests } = await import('./keychain.js');

describe('isKeychainAvailable on Linux (HS-9019 probe)', () => {
  beforeEach(() => {
    plat = 'linux';
    binaryPresent = true;
    daemonUp = true;
    secrets.clear();
    __resetKeychainAvailabilityCacheForTests();
  });
  afterEach(() => __resetKeychainAvailabilityCacheForTests());

  it('is true when secret-tool + a working keyring round-trip succeed', async () => {
    expect(await isKeychainAvailable()).toBe(true);
  });

  it('is false when secret-tool is not installed', async () => {
    binaryPresent = false;
    expect(await isKeychainAvailable()).toBe(false);
  });

  it('is false when the binary is present but the keyring daemon is down', async () => {
    daemonUp = false;
    // The old `which`-only check would have returned true here — the regression.
    expect(await isKeychainAvailable()).toBe(false);
  });

  it('is false on an unsupported platform (e.g. Windows)', async () => {
    plat = 'win32';
    __resetKeychainAvailabilityCacheForTests();
    expect(await isKeychainAvailable()).toBe(false);
  });
});
