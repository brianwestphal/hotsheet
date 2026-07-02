/**
 * HS-9279 (epic HS-9226 Phase 3b) — shared tool-latency histogram bucketing.
 *
 * Extracted into a leaf module so the READ (`otelRollups.ts::getToolLatencyHistogram`),
 * the INGEST (`otelRollupIngest.ts::recordToolActivity`), and the BACKFILL
 * (`otelRollupBackfill.ts::backfillActivityToolForDir`) all bucket a duration the
 * same way — the rollup stores per-(tool, bucketIndex) counts, so the boundaries
 * must be identical at write and read time.
 *
 * The 8 logarithmic buckets match the pre-9279 raw-SQL scheme (the old
 * `buildHistogramBucketCase`): bucket `i` (i < 7) is `[lower[i], upper[i])`, and
 * bucket 7 is the open `[10000ms, ∞)` tail.
 */

/** Exclusive upper bound (ms) of buckets 0..6; bucket 7 is everything ≥ the last. */
export const HISTOGRAM_BUCKET_UPPER_MS = [10, 50, 100, 500, 1000, 5000, 10000] as const;

/** Inclusive lower bound (ms) of each of the 8 buckets. */
const HISTOGRAM_BUCKET_LOWER_MS = [0, 10, 50, 100, 500, 1000, 5000, 10000] as const;

/** The number of buckets (8): the 7 bounded ranges + the open tail. */
export const HISTOGRAM_BUCKET_COUNT = HISTOGRAM_BUCKET_UPPER_MS.length + 1;

/**
 * Bucket index (0..7) for a duration in ms — mirrors the old raw-SQL
 * `CASE WHEN ms < upper[i] THEN i … ELSE 7`.
 */
export function latencyBucketIndex(ms: number): number {
  for (let i = 0; i < HISTOGRAM_BUCKET_UPPER_MS.length; i++) {
    if (ms < HISTOGRAM_BUCKET_UPPER_MS[i]) return i;
  }
  return HISTOGRAM_BUCKET_UPPER_MS.length; // 7 — the open tail
}

/**
 * Approximate the p-th percentile (p in 0..1) of a latency distribution given only
 * the per-bucket counts, by linear interpolation within the bucket the cumulative
 * count crosses. Returns null for an empty distribution. This REPLACES the exact
 * `percentile_cont` over raw durations (maintainer-accepted approximation, HS-9279):
 * the open tail bucket can only report its lower bound (10000ms).
 */
export function percentileFromBuckets(buckets: readonly number[], p: number): number | null {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const target = p * total;
  let cum = 0;
  for (let i = 0; i < buckets.length; i++) {
    const next = cum + buckets[i];
    if (next >= target && buckets[i] > 0) {
      const lower = HISTOGRAM_BUCKET_LOWER_MS[i] ?? 0;
      // Open tail (no upper bound) → report the lower bound; else interpolate.
      const upper = i < HISTOGRAM_BUCKET_UPPER_MS.length ? HISTOGRAM_BUCKET_UPPER_MS[i] : lower;
      const frac = (target - cum) / buckets[i];
      return lower + frac * (upper - lower);
    }
    cum = next;
  }
  return HISTOGRAM_BUCKET_LOWER_MS[HISTOGRAM_BUCKET_LOWER_MS.length - 1];
}
