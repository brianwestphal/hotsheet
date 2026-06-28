/** HS-9131 — global diagnostics opt-in cache (`globalDiagnostics.ts`). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _diagnosticsLoadedForTesting,
  _setDiagnosticsEnabledForTesting,
  isDiagnosticsEnabled,
  loadGlobalDiagnostics,
  setDiagnosticsEnabled,
} from './globalDiagnostics.js';

const getGlobalConfigMock = vi.fn<() => Promise<{ diagnosticsEnabled?: unknown }>>();
const updateGlobalConfigMock = vi.fn<(b: unknown) => Promise<unknown>>();
vi.mock('../api/index.js', () => ({
  getGlobalConfig: () => getGlobalConfigMock(),
  updateGlobalConfig: (b: unknown) => updateGlobalConfigMock(b),
}));

beforeEach(() => {
  _setDiagnosticsEnabledForTesting(false);
  getGlobalConfigMock.mockReset().mockResolvedValue({});
  updateGlobalConfigMock.mockReset().mockResolvedValue({});
});
afterEach(() => { _setDiagnosticsEnabledForTesting(false); });

describe('globalDiagnostics', () => {
  it('defaults disabled', () => { expect(isDiagnosticsEnabled()).toBe(false); });
  it('load enables only on an explicit true, marking loaded', async () => {
    getGlobalConfigMock.mockResolvedValue({ diagnosticsEnabled: true });
    await loadGlobalDiagnostics();
    expect(isDiagnosticsEnabled()).toBe(true);
    expect(_diagnosticsLoadedForTesting()).toBe(true);
  });
  it('load treats a non-true value as disabled', async () => {
    _setDiagnosticsEnabledForTesting(true);
    getGlobalConfigMock.mockResolvedValue({ diagnosticsEnabled: 'yes' });
    await loadGlobalDiagnostics();
    expect(isDiagnosticsEnabled()).toBe(false);
  });
  it('load keeps the cached value on fetch error', async () => {
    _setDiagnosticsEnabledForTesting(true);
    getGlobalConfigMock.mockRejectedValue(new Error('offline'));
    await loadGlobalDiagnostics();
    expect(isDiagnosticsEnabled()).toBe(true);
  });
  it('set persists + updates the cache', async () => {
    await setDiagnosticsEnabled(true);
    expect(isDiagnosticsEnabled()).toBe(true);
    expect(updateGlobalConfigMock).toHaveBeenCalledWith({ diagnosticsEnabled: true });
  });
});
