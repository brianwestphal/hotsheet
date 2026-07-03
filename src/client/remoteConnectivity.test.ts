// HS-9305 — the per-project connectivity store (docs/112 §112.8).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetConnectivityForTesting, connectivity, getConnectivity, setConnectivity } from './remoteConnectivity.js';

describe('remoteConnectivity store', () => {
  beforeEach(() => { _resetConnectivityForTesting(); });
  afterEach(() => { _resetConnectivityForTesting(); });

  it('reports "unknown" for a never-seen secret', () => {
    expect(getConnectivity('nope')).toBe('unknown');
  });

  it('sets + reads per-secret state', () => {
    setConnectivity('a', 'connected');
    setConnectivity('b', 'unreachable');
    expect(getConnectivity('a')).toBe('connected');
    expect(getConnectivity('b')).toBe('unreachable');
  });

  it('ignores an empty secret', () => {
    setConnectivity('', 'connected');
    expect(connectivity().value).toEqual({});
  });

  it('replaces the map reference on a real change (so effects fire) but not on a no-op', () => {
    setConnectivity('a', 'reconnecting');
    const ref1 = connectivity().value;
    setConnectivity('a', 'connected'); // change → new reference
    const ref2 = connectivity().value;
    expect(ref2).not.toBe(ref1);
    setConnectivity('a', 'connected'); // no-op → same reference
    expect(connectivity().value).toBe(ref2);
  });
});
