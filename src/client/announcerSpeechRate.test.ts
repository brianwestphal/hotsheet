// @vitest-environment happy-dom
/** HS-9131 — Announcer playback-rate cache (`announcerSpeechRate.ts`). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _setAnnouncerSpeechRateForTesting,
  clampRate,
  DEFAULT_RATE,
  getAnnouncerSpeechRate,
  loadAnnouncerSpeechRate,
  MAX_RATE,
  MIN_RATE,
  setAnnouncerSpeechRate,
} from './announcerSpeechRate.js';

const getGlobalConfigMock = vi.fn<() => Promise<{ announcerSpeechRate?: unknown }>>();
const updateGlobalConfigMock = vi.fn<(b: unknown) => Promise<unknown>>();
vi.mock('../api/index.js', () => ({
  getGlobalConfig: () => getGlobalConfigMock(),
  updateGlobalConfig: (b: unknown) => updateGlobalConfigMock(b),
}));

beforeEach(() => {
  _setAnnouncerSpeechRateForTesting(DEFAULT_RATE);
  getGlobalConfigMock.mockReset().mockResolvedValue({});
  updateGlobalConfigMock.mockReset().mockResolvedValue({});
});
afterEach(() => { _setAnnouncerSpeechRateForTesting(DEFAULT_RATE); });

describe('clampRate', () => {
  it('clamps to [MIN, MAX] and defaults non-finite input', () => {
    expect(clampRate(0.1)).toBe(MIN_RATE);
    expect(clampRate(99)).toBe(MAX_RATE);
    expect(clampRate(1.25)).toBe(1.25);
    expect(clampRate(NaN)).toBe(DEFAULT_RATE);
    expect(clampRate(Infinity)).toBe(DEFAULT_RATE);
  });
});

describe('load/get/set', () => {
  it('defaults to DEFAULT_RATE before load', () => {
    expect(getAnnouncerSpeechRate()).toBe(DEFAULT_RATE);
  });
  it('loadAnnouncerSpeechRate applies (clamped) config value', async () => {
    getGlobalConfigMock.mockResolvedValue({ announcerSpeechRate: 5 });
    await loadAnnouncerSpeechRate();
    expect(getAnnouncerSpeechRate()).toBe(MAX_RATE); // clamped
  });
  it('loadAnnouncerSpeechRate ignores a non-number value', async () => {
    getGlobalConfigMock.mockResolvedValue({ announcerSpeechRate: 'fast' });
    await loadAnnouncerSpeechRate();
    expect(getAnnouncerSpeechRate()).toBe(DEFAULT_RATE);
  });
  it('loadAnnouncerSpeechRate keeps the cached value on fetch error', async () => {
    _setAnnouncerSpeechRateForTesting(1.5);
    getGlobalConfigMock.mockRejectedValue(new Error('offline'));
    await loadAnnouncerSpeechRate();
    expect(getAnnouncerSpeechRate()).toBe(1.5);
  });
  it('setAnnouncerSpeechRate clamps, persists, and fires the rate-changed event', async () => {
    const spy = vi.fn();
    document.addEventListener('hotsheet:announcer-rate-changed', spy);
    await setAnnouncerSpeechRate(99);
    expect(getAnnouncerSpeechRate()).toBe(MAX_RATE);
    expect(updateGlobalConfigMock).toHaveBeenCalledWith({ announcerSpeechRate: MAX_RATE });
    expect(spy).toHaveBeenCalledTimes(1);
    document.removeEventListener('hotsheet:announcer-rate-changed', spy);
  });
});
