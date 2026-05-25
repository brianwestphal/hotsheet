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
  webglWantedForConsumer,
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

// HS-8619 — the guard that keeps WebGL out of CSS-scaled tile contexts. The
// §54 checkout reconciles the renderer from this: a `scaled` consumer (§25
// dashboard / §36 drawer-grid tiles + magnified overlay) gets the DOM renderer
// because the WebGL canvas raster-scales badly under a CSS transform; full-size
// consumers (drawer / dedicated view) keep WebGL.
describe('webglWantedForConsumer (HS-8619)', () => {
  it('returns true only when WebGL is desired AND the consumer is not scaled', () => {
    expect(webglWantedForConsumer(true, false)).toBe(true);
  });

  it('returns false for a scaled consumer even when WebGL is desired', () => {
    expect(webglWantedForConsumer(true, true)).toBe(false);
  });

  it('returns false when WebGL was never desired, regardless of scale', () => {
    expect(webglWantedForConsumer(false, false)).toBe(false);
    expect(webglWantedForConsumer(false, true)).toBe(false);
  });
});
