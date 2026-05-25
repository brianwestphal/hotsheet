// @vitest-environment happy-dom
/**
 * HS-8488 — renderer-decision tests. `shouldUseWebglRenderer()` is the gate
 * `terminalCheckout.tsx::createEntry` consults before loading the WebGL addon;
 * it must return false (→ DOM renderer) when force-disabled (e2e), when the
 * user opted out, or when WebGL2 isn't available — and true only when all
 * three say go.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _setTerminalWebglOptOutForTesting,
  _setWebgl2AvailableForTesting,
  isWebgl2Available,
  shouldUseWebglRenderer,
} from './terminalWebgl.js';

const win = window as unknown as { __HOTSHEET_DISABLE_WEBGL__?: boolean };

beforeEach(() => {
  _setTerminalWebglOptOutForTesting(false);
  _setWebgl2AvailableForTesting(true); // pretend WebGL2 exists unless a test says otherwise
  delete win.__HOTSHEET_DISABLE_WEBGL__;
});

afterEach(() => {
  _setTerminalWebglOptOutForTesting(false);
  _setWebgl2AvailableForTesting(null);
  delete win.__HOTSHEET_DISABLE_WEBGL__;
});

describe('shouldUseWebglRenderer (HS-8488)', () => {
  it('returns true when not opted out, WebGL2 is available, and not force-disabled', () => {
    expect(shouldUseWebglRenderer()).toBe(true);
  });

  it('returns false when the user opted out (software-rendering setting)', () => {
    _setTerminalWebglOptOutForTesting(true);
    expect(shouldUseWebglRenderer()).toBe(false);
  });

  it('returns false when WebGL2 is unavailable', () => {
    _setWebgl2AvailableForTesting(false);
    expect(shouldUseWebglRenderer()).toBe(false);
  });

  it('returns false when force-disabled via the e2e window flag, even with everything else green', () => {
    win.__HOTSHEET_DISABLE_WEBGL__ = true;
    expect(shouldUseWebglRenderer()).toBe(false);
  });
});

describe('isWebgl2Available (HS-8488)', () => {
  it('returns the forced test value (caches across calls)', () => {
    _setWebgl2AvailableForTesting(true);
    expect(isWebgl2Available()).toBe(true);
    _setWebgl2AvailableForTesting(false);
    expect(isWebgl2Available()).toBe(false);
  });
});
