// @vitest-environment happy-dom
/** HS-9131 — `isDemoMode()` reads the server-stamped `window.__HOTSHEET_DEMO__`. */
import { afterEach, describe, expect, it } from 'vitest';

import { isDemoMode } from './demoMode.js';

afterEach(() => { delete (window as unknown as { __HOTSHEET_DEMO__?: boolean }).__HOTSHEET_DEMO__; });

describe('isDemoMode', () => {
  it('is false when the demo stamp is absent', () => {
    expect(isDemoMode()).toBe(false);
  });
  it('is true only for an exact === true stamp', () => {
    (window as unknown as { __HOTSHEET_DEMO__?: unknown }).__HOTSHEET_DEMO__ = true;
    expect(isDemoMode()).toBe(true);
  });
  it('is false for a truthy-but-not-true stamp', () => {
    (window as unknown as { __HOTSHEET_DEMO__?: unknown }).__HOTSHEET_DEMO__ = 1;
    expect(isDemoMode()).toBe(false);
  });
});
