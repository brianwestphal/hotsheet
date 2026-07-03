// @vitest-environment happy-dom
// HS-9191 — the localStorage-backed synthetic device id (docs/109 §109.3).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetDeviceIdCacheForTesting, getOrCreateDeviceId } from './deviceId.js';

describe('getOrCreateDeviceId', () => {
  beforeEach(() => { localStorage.clear(); _resetDeviceIdCacheForTesting(); });
  afterEach(() => { localStorage.clear(); _resetDeviceIdCacheForTesting(); });

  it('mints, persists, and returns a stable id', () => {
    const id = getOrCreateDeviceId();
    expect(id).toBeTruthy();
    expect(localStorage.getItem('hotsheet:deviceId')).toBe(id);
    // Same id on repeat calls (in-memory cache).
    expect(getOrCreateDeviceId()).toBe(id);
  });

  it('reuses an existing persisted id across a fresh module cache', () => {
    localStorage.setItem('hotsheet:deviceId', 'preexisting-uuid');
    _resetDeviceIdCacheForTesting(); // simulate a page reload (fresh in-memory cache)
    expect(getOrCreateDeviceId()).toBe('preexisting-uuid');
  });

  it('mints distinct ids for distinct storage states', () => {
    const first = getOrCreateDeviceId();
    localStorage.clear();
    _resetDeviceIdCacheForTesting();
    const second = getOrCreateDeviceId();
    expect(second).not.toBe(first);
  });
});
