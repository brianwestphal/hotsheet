/**
 * HS-9535 — the skip decision.
 *
 * Every test here is a way to skip a backup that should have been taken. That
 * asymmetry is the whole design: an unnecessary backup costs CPU, a wrongly
 * skipped one costs data, so every ambiguous input must resolve to "back up".
 */

import { describe, expect, it } from 'vitest';

import { markerKey, readChangeMarker, shouldSkipBackup } from './changeMarker.js';

const okDb = (lsn: unknown) => ({
  query: () => Promise.resolve({ rows: [{ lsn }] }),
});

describe('readChangeMarker', () => {
  it('returns the WAL position', async () => {
    expect(await readChangeMarker(okDb('1/3B6F2D8'))).toBe('1/3B6F2D8');
  });

  it('returns null when the query throws — a cluster that cannot answer is backed up', async () => {
    const db = { query: () => Promise.reject(new Error('PGlite is closed')) };
    expect(await readChangeMarker(db)).toBeNull();
  });

  it('returns null for an empty or non-string result rather than coercing', async () => {
    // A coerced '' or 'undefined' would compare EQUAL to a previous coerced value
    // and skip every backup forever — silent, permanent data loss.
    expect(await readChangeMarker(okDb(''))).toBeNull();
    expect(await readChangeMarker(okDb(undefined))).toBeNull();
    expect(await readChangeMarker(okDb(null))).toBeNull();
    expect(await readChangeMarker(okDb(12345))).toBeNull();
  });

  it('returns null when the result has no rows', async () => {
    expect(await readChangeMarker({ query: () => Promise.resolve({ rows: [] }) })).toBeNull();
  });
});

describe('shouldSkipBackup', () => {
  it('skips only when both markers are present and identical', () => {
    expect(shouldSkipBackup('1/A', '1/A')).toBe(true);
  });

  it('backs up when the position has moved', () => {
    expect(shouldSkipBackup('1/B', '1/A')).toBe(false);
  });

  it('backs up when the current marker is unreadable', () => {
    // The cluster could not answer. Skipping here would mean skipping on doubt.
    expect(shouldSkipBackup(null, '1/A')).toBe(false);
  });

  it('backs up when there is no stored marker — first run, or a fresh install', () => {
    expect(shouldSkipBackup('1/A', undefined)).toBe(false);
    expect(shouldSkipBackup('1/A', null)).toBe(false);
  });

  it('backs up when BOTH are missing, rather than treating null === null as unchanged', () => {
    // The trap: two absent values are "equal" to a naive comparison, which would
    // skip every backup on a cluster that never reports a marker.
    expect(shouldSkipBackup(null, null)).toBe(false);
    expect(shouldSkipBackup(null, undefined)).toBe(false);
  });
});

describe('markerKey', () => {
  it('separates tiers within a project', () => {
    // A project idle for an hour should skip its hourly backup too, and each
    // tier last ran at a different moment. One key per project would let the
    // 5-minute tier's decision suppress the hourly one.
    expect(markerKey('/p', '5min')).not.toBe(markerKey('/p', 'hourly'));
  });

  it('separates projects within a tier', () => {
    expect(markerKey('/a', '5min')).not.toBe(markerKey('/b', '5min'));
  });

  it('is stable for the same inputs', () => {
    expect(markerKey('/p', '5min')).toBe(markerKey('/p', '5min'));
  });
});
