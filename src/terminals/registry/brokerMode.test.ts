import { afterEach, describe, expect, it } from 'vitest';

import { isBrokerMode } from './brokerMode.js';

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
