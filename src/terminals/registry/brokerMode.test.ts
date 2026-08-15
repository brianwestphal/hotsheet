import { afterEach, describe, expect, it } from 'vitest';

import { brokerSocketPathFor, brokerSpawnOptions, isBrokerMode } from './brokerMode.js';

/**
 * HS-9662 — the broker gate defaults ON in real runs (so beta/packaged users get
 * terminal survival), but the unit suite MUST stay off (vitest.setup.ts sets
 * `HOTSHEET_PTY_BROKER=0`) or `registry.test.ts` et al. would route to the detached
 * broker and spawn real processes. This pins that + the explicit overrides.
 */
describe('isBrokerMode gate', () => {
  const prev = process.env.HOTSHEET_PTY_BROKER;
  afterEach(() => {
    if (prev === undefined) delete process.env.HOTSHEET_PTY_BROKER;
    else process.env.HOTSHEET_PTY_BROKER = prev;
  });

  it('is OFF in the unit suite (vitest.setup.ts forces =0)', () => {
    expect(process.env.HOTSHEET_PTY_BROKER).toBe('0');
    expect(isBrokerMode()).toBe(false);
  });

  it('=1 forces on; =0 forces off', () => {
    process.env.HOTSHEET_PTY_BROKER = '1';
    expect(isBrokerMode()).toBe(true);
    process.env.HOTSHEET_PTY_BROKER = '0';
    expect(isBrokerMode()).toBe(false);
  });

  it('defaults ON when unset on a non-Windows host', () => {
    delete process.env.HOTSHEET_PTY_BROKER;
    // The test host is macOS/Linux; Windows is carved out (HS-9666).
    expect(isBrokerMode()).toBe(process.platform !== 'win32');
  });
});

/**
 * HS-9666 — the platform transport is chosen by pure functions (the
 * `build_kill_command` pattern), so both OS branches are testable on any host.
 */
describe('brokerSocketPathFor (HS-9666)', () => {
  it('unix → a .sock file inside the instance dir', () => {
    expect(brokerSocketPathFor('darwin', '/home/u/.hotsheet')).toBe('/home/u/.hotsheet/pty-broker.sock');
    expect(brokerSocketPathFor('linux', '/x/y')).toBe('/x/y/pty-broker.sock');
  });

  it('win32 → a \\\\.\\pipe named pipe (no directory path)', () => {
    const p = brokerSocketPathFor('win32', 'C:\\Users\\u\\.hotsheet');
    expect(p).toMatch(/^\\\\\.\\pipe\\hotsheet-pty-broker-[0-9a-f]{8}$/);
  });

  it('win32 pipe name is stable per dir + unique across dirs (global namespace scoping)', () => {
    const a1 = brokerSocketPathFor('win32', 'C:\\a\\.hotsheet');
    const a2 = brokerSocketPathFor('win32', 'C:\\a\\.hotsheet');
    const b = brokerSocketPathFor('win32', 'C:\\b\\.hotsheet');
    expect(a1).toBe(a2); // deterministic
    expect(a1).not.toBe(b); // different HOTSHEET_HOME → different pipe
  });
});

describe('brokerSpawnOptions (HS-9666)', () => {
  it('unix → detached only', () => {
    expect(brokerSpawnOptions('darwin')).toEqual({ detached: true });
    expect(brokerSpawnOptions('linux')).toEqual({ detached: true });
  });

  it('win32 → detached + windowsHide', () => {
    expect(brokerSpawnOptions('win32')).toEqual({ detached: true, windowsHide: true });
  });
});
