/**
 * HS-9279 — pure tool-latency histogram helpers shared by the read / ingest /
 * backfill so the bucket boundaries can't drift.
 */
import { describe, expect, it } from 'vitest';

import { HISTOGRAM_BUCKET_COUNT, latencyBucketIndex, percentileFromBuckets } from './otelHistogram.js';

describe('latencyBucketIndex (HS-9279)', () => {
  it('maps durations to the 8 log buckets (matches the old CASE thresholds)', () => {
    expect(latencyBucketIndex(0)).toBe(0);
    expect(latencyBucketIndex(9.9)).toBe(0);   // < 10
    expect(latencyBucketIndex(10)).toBe(1);    // [10, 50)
    expect(latencyBucketIndex(49)).toBe(1);
    expect(latencyBucketIndex(50)).toBe(2);
    expect(latencyBucketIndex(100)).toBe(3);
    expect(latencyBucketIndex(500)).toBe(4);
    expect(latencyBucketIndex(1000)).toBe(5);
    expect(latencyBucketIndex(5000)).toBe(6);
    expect(latencyBucketIndex(9999)).toBe(6);
    expect(latencyBucketIndex(10000)).toBe(7); // open tail
    expect(latencyBucketIndex(999999)).toBe(7);
  });
  it('has 8 buckets', () => {
    expect(HISTOGRAM_BUCKET_COUNT).toBe(8);
  });
});

describe('percentileFromBuckets (HS-9279)', () => {
  it('returns null for an empty distribution', () => {
    expect(percentileFromBuckets(new Array<number>(8).fill(0), 0.5)).toBeNull();
  });

  it('interpolates within the crossing bucket', () => {
    // 10 in bucket 0 ([0,10)), 1 in bucket 5. p50: target = 5.5 → within bucket 0 →
    // 0 + (5.5/10)*10 = 5.5.
    const buckets = [10, 0, 0, 0, 0, 1, 0, 0];
    expect(percentileFromBuckets(buckets, 0.5)).toBeCloseTo(5.5, 5);
  });

  it('lands a high percentile in the correct upper bucket', () => {
    // 8 in bucket 0, 2 in bucket 3 ([100,500)). p90: target = 9 → cumulative 8 (bucket0)
    // then bucket3 crosses → lower 100 + ((9-8)/2)*(500-100) = 100 + 200 = 300.
    const buckets = [8, 0, 0, 2, 0, 0, 0, 0];
    expect(percentileFromBuckets(buckets, 0.9)).toBeCloseTo(300, 5);
  });

  it('reports the open tail’s lower bound (no upper bound to interpolate to)', () => {
    const buckets = [0, 0, 0, 0, 0, 0, 0, 5]; // all in bucket 7 ([10000, ∞))
    expect(percentileFromBuckets(buckets, 0.5)).toBe(10000);
  });
});
