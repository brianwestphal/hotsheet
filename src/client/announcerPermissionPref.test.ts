/** HS-9131 — "speak permission checks" pref cache (`announcerPermissionPref.ts`).
 *  Default ON: only an explicit stored `false` disables it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _setAnnouncerSpeakPermissionsForTesting,
  getAnnouncerSpeakPermissions,
  loadAnnouncerSpeakPermissions,
  setAnnouncerSpeakPermissions,
} from './announcerPermissionPref.js';

const getGlobalConfigMock = vi.fn<() => Promise<{ announcerSpeakPermissions?: unknown }>>();
const updateGlobalConfigMock = vi.fn<(b: unknown) => Promise<unknown>>();
vi.mock('../api/index.js', () => ({
  getGlobalConfig: () => getGlobalConfigMock(),
  updateGlobalConfig: (b: unknown) => updateGlobalConfigMock(b),
}));

beforeEach(() => {
  _setAnnouncerSpeakPermissionsForTesting(true);
  getGlobalConfigMock.mockReset().mockResolvedValue({});
  updateGlobalConfigMock.mockReset().mockResolvedValue({});
});
afterEach(() => { _setAnnouncerSpeakPermissionsForTesting(true); });

describe('announcerPermissionPref', () => {
  it('defaults ON', () => {
    expect(getAnnouncerSpeakPermissions()).toBe(true);
  });
  it('load keeps ON when the field is absent (undefined = enabled)', async () => {
    getGlobalConfigMock.mockResolvedValue({});
    await loadAnnouncerSpeakPermissions();
    expect(getAnnouncerSpeakPermissions()).toBe(true);
  });
  it('load disables only on an explicit false', async () => {
    getGlobalConfigMock.mockResolvedValue({ announcerSpeakPermissions: false });
    await loadAnnouncerSpeakPermissions();
    expect(getAnnouncerSpeakPermissions()).toBe(false);
  });
  it('load keeps the cached value on fetch error', async () => {
    _setAnnouncerSpeakPermissionsForTesting(false);
    getGlobalConfigMock.mockRejectedValue(new Error('offline'));
    await loadAnnouncerSpeakPermissions();
    expect(getAnnouncerSpeakPermissions()).toBe(false);
  });
  it('set persists + updates the cache', async () => {
    await setAnnouncerSpeakPermissions(false);
    expect(getAnnouncerSpeakPermissions()).toBe(false);
    expect(updateGlobalConfigMock).toHaveBeenCalledWith({ announcerSpeakPermissions: false });
  });
});
