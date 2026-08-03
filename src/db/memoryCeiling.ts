/**
 * HS-9555 (docs/128 §128.5) — the ceiling the PGLite cluster budget is measured
 * against.
 *
 * ## The number this replaces was never a ceiling on this memory
 *
 * Every memory guard in docs/128 compares `process.memoryUsage().external` —
 * which is almost entirely PGLite WASM heaps — against
 * `v8.getHeapStatistics().heap_size_limit`, and `heapSizeLimitBytes` used to be
 * commented "V8's hard heap ceiling (the OOM boundary)". For the JS heap that is
 * true. For `external` it is not: a WASM heap is malloc'd native memory that
 * lives entirely OUTSIDE the V8 old space, so the old-space limit does not bound
 * it, does not fail an allocation at it, and does not abort the process past it.
 * The real boundary for `external` is the machine.
 *
 * So on a 32 GB machine Hot Sheet was budgeting its cluster cache against
 * **4144 MB** — V8's *default* old-space size, a number nobody in this project
 * ever chose. Measured on the maintainer's machine during the 2026-08-01 death:
 * the kernel reported memory pressure `normal` throughout (docs/131 working
 * correctly) while Hot Sheet evicted itself into a churn spiral against a limit
 * that had nothing to do with the memory it was trying to bound.
 *
 * ## Why that number specifically caused the spiral
 *
 * The caps and the guard were mutually inconsistent, and the old ceiling is what
 * made them so. A full working set is `maxOpen` 10 + `maxTelemetryOpen` 6 = 16
 * clusters ≈ **2.9 GB**. The headroom guard fires when external rises above
 * `ceiling - headroomFloorBytes` = 4144 − 768 = **3376 MB**. That leaves ~480 MB
 * between "the cache is legitimately full" and "start pressure-evicting" — less
 * than three clusters' worth, and far less than the unreclaimed heaps that always
 * exist between forced collections (docs/128 §128.5.6: a closed cluster's heap
 * returns on GC, not at `close()`).
 *
 * So the guard fired during *normal operation with a full cache*, evicted, the
 * closes had not been collected yet, external did not drop, and it evicted again.
 * Raising the ceiling does not paper over that — it removes the condition, by
 * giving the guard the room the caps already assume it has.
 *
 * ## Why not just pass `--max-old-space-size`
 *
 * Measured, because it is the obvious first idea and it does not work:
 *
 *     node                        -> heap_size_limit 4144 MB
 *     v8.setFlagsFromString('--max-old-space-size=12288') -> still 4144 MB
 *     node --max-old-space-size=12288 -> 12336 MB
 *
 * The flag is only honored at launcher level, and Hot Sheet has three launchers
 * (the `dist/cli.js` npm bin, the Tauri sidecar, the dev `node --import tsx`
 * spawn). A shebang cannot portably carry node flags, so the npm bin would need
 * a re-exec — which would break the Tauri PID tracking that deliberately spawns
 * the server so "its PID is directly killable" (`src-tauri/src/lib.rs`).
 *
 * And it would be treating the wrong thing anyway: at the wedge `heapUsed` was
 * **184 MB of 4144 MB**. The JS heap was never under pressure. Only the
 * *denominator* was wrong, and that is a one-line policy choice, not a launcher
 * change. Raising the old-space limit remains available and orthogonal; it is not
 * what this bug needed.
 *
 * ## The policy
 *
 * A quarter of machine RAM, floored at the old heap-limit value so no machine
 * ever gets a smaller budget than it has today, and capped so a very large
 * machine doesn't authorize an absurd cache. The count caps
 * (`HOTSHEET_MAX_OPEN_CLUSTERS` et al.) remain the real bound on residency — this
 * only governs when the *pressure* guards start fighting.
 */
import os from 'node:os';
import v8 from 'node:v8';

/** Share of machine RAM the cluster cache may be budgeted against. */
export const EXTERNAL_CEILING_FRACTION = 0.25;

/**
 * Absolute cap. With `maxOpen` 10 + `maxTelemetryOpen` 6 a full cache is ~2.9 GB,
 * so anything past this can only ever be headroom for uncollected heaps; a
 * 256 GB machine has no reason to authorize 64 GB of it.
 */
export const MAX_EXTERNAL_CEILING_BYTES = 12 * 1024 * 1024 * 1024;

/** Env override, in bytes. */
export const EXTERNAL_CEILING_ENV = 'HOTSHEET_EXTERNAL_CEILING_BYTES';

/**
 * Pure resolver, so the policy is unit-testable without a specific machine.
 *
 * `heapLimitBytes` is the FLOOR rather than the basis: it is what every guard
 * used before this module, so flooring at it makes the change monotonic — a
 * machine can only gain budget, never lose it. That matters because the small-RAM
 * case is exactly where a fraction-of-RAM rule would otherwise *tighten* things
 * (8 GB × 25% = 2 GB, below the ~2–4 GB default old-space limit such a machine
 * already had).
 *
 * A non-finite or non-positive input is treated as "unknown" and falls back
 * rather than propagating a NaN into an eviction decision.
 */
export function resolveExternalCeilingBytes(input: {
  totalMemBytes: number;
  heapLimitBytes: number;
  override?: string | undefined;
}): number {
  const floor = usable(input.heapLimitBytes) ? input.heapLimitBytes : MAX_EXTERNAL_CEILING_BYTES;

  // An explicit override wins outright — including below the floor. Someone
  // setting this is tuning deliberately (a constrained container, a repro), and
  // silently raising it to the floor would make the knob look broken.
  const overridden = Number(input.override);
  if (input.override !== undefined && input.override !== '' && usable(overridden)) return overridden;

  if (!usable(input.totalMemBytes)) return floor;
  const share = Math.floor(input.totalMemBytes * EXTERNAL_CEILING_FRACTION);
  return Math.min(Math.max(share, floor), Math.max(MAX_EXTERNAL_CEILING_BYTES, floor));
}

function usable(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

let cached: number | null = null;

/**
 * The live ceiling. Memoized: neither machine RAM nor the heap limit changes
 * within a process, and this is read on every eviction pass.
 */
export function externalCeilingBytes(): number {
  if (cached !== null) return cached;
  cached = resolveExternalCeilingBytes({
    totalMemBytes: os.totalmem(),
    heapLimitBytes: v8.getHeapStatistics().heap_size_limit,
    override: process.env[EXTERNAL_CEILING_ENV],
  });
  return cached;
}

/** Test seam — re-read the environment and the machine. */
export function resetExternalCeilingForTests(): void {
  cached = null;
}

/** One-line boot summary. `usedPctOfCeiling` in a freeze log is uninterpretable
 *  without knowing the denominator, and before this it was never recorded.
 *  (HS-9559 renamed that field from `usedPctOfLimit` when the diagnostics moved
 *  onto this ceiling too, so a log line's field name now says which denominator
 *  produced it.) */
export function describeExternalCeiling(): string {
  const mb = (b: number): number => Math.round(b / (1024 * 1024));
  const ceiling = externalCeilingBytes();
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  const overridden = (process.env[EXTERNAL_CEILING_ENV] ?? '') !== '';
  return `[db] PGLite cluster budget ceiling: ${String(mb(ceiling))}MB`
    + ` (machine RAM ${String(mb(os.totalmem()))}MB, V8 heap limit ${String(mb(heapLimit))}MB`
    + `${overridden ? `, overridden via ${EXTERNAL_CEILING_ENV}` : ''})`;
}
