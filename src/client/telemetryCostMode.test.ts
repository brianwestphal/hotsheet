/** HS-9131 — telemetry billing-mode cache (`telemetryCostMode.ts`). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _setTelemetryCostModeForTesting,
  _telemetryCostModeLoadedForTesting,
  getTelemetryCostMode,
  loadTelemetryCostMode,
  setTelemetryCostMode,
} from './telemetryCostMode.js';

const getGlobalConfigMock = vi.fn<() => Promise<{ telemetryCostMode?: unknown }>>();
const updateGlobalConfigMock = vi.fn<(b: unknown) => Promise<unknown>>();
vi.mock('../api/index.js', () => ({
  getGlobalConfig: () => getGlobalConfigMock(),
  updateGlobalConfig: (b: unknown) => updateGlobalConfigMock(b),
}));

beforeEach(() => {
  _setTelemetryCostModeForTesting('api');
  getGlobalConfigMock.mockReset().mockResolvedValue({});
  updateGlobalConfigMock.mockReset().mockResolvedValue({});
});
afterEach(() => { _setTelemetryCostModeForTesting('api'); });

describe('telemetryCostMode', () => {
  it("defaults to 'api'", () => { expect(getTelemetryCostMode()).toBe('api'); });
  it('load applies subscription, marking loaded', async () => {
    getGlobalConfigMock.mockResolvedValue({ telemetryCostMode: 'subscription' });
    await loadTelemetryCostMode();
    expect(getTelemetryCostMode()).toBe('subscription');
    expect(_telemetryCostModeLoadedForTesting()).toBe(true);
  });
  it("load coerces any non-'subscription' value to 'api'", async () => {
    _setTelemetryCostModeForTesting('subscription');
    getGlobalConfigMock.mockResolvedValue({ telemetryCostMode: 'weird' });
    await loadTelemetryCostMode();
    expect(getTelemetryCostMode()).toBe('api');
  });
  it('load keeps the cached value on fetch error', async () => {
    _setTelemetryCostModeForTesting('subscription');
    getGlobalConfigMock.mockRejectedValue(new Error('offline'));
    await loadTelemetryCostMode();
    expect(getTelemetryCostMode()).toBe('subscription');
  });
  it('set persists + updates the cache', async () => {
    await setTelemetryCostMode('subscription');
    expect(getTelemetryCostMode()).toBe('subscription');
    expect(updateGlobalConfigMock).toHaveBeenCalledWith({ telemetryCostMode: 'subscription' });
  });
});
