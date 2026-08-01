/**
 * HS-9479 (docs/128 §128.5.6) — make V8 collect after we close a PGLite cluster.
 *
 * ## Why this is necessary at all
 *
 * V8 runs a major GC when the JS **heap** is under pressure. A PGLite cluster's
 * ~180–250 MB lives in `external` (WASM memory), which creates no heap pressure
 * whatsoever. So closing a cluster drops the last reference and then *nothing
 * happens*: the memory stays resident until some unrelated allocation happens to
 * trigger a collection.
 *
 * Measured (HS-9481), and this is the whole bug in two lines:
 *
 *     close 4 clusters, wait 5 s, no forced GC  -> 1197 MB   (nothing freed)
 *     then force a collection                   ->  194 MB   (all of it freed)
 *
 * Left alone, `external` climbs — in the 2026-07-29 death it reached 8449 MB
 * against a 4144 MB ceiling while `heapUsed` sat at a relaxed 231 MB — and the
 * §45 watchdog SIGKILLs the process for wedging in GC thrash. Worse, the headroom
 * guard reacts to the un-freed memory by evicting *more*, while the work that
 * needed a cluster reopens one and allocates a fresh heap, so each cycle net ADDS
 * memory (375 evictions / 372 reopens in ~130 s, `external` rising throughout).
 *
 * Eviction policy cannot fix that. Every layer in docs/128 assumes closing returns
 * memory, and without this it does not.
 *
 * ## Why no launcher flag
 *
 * `--expose-gc` would have to be added to the npm bin, the Tauri sidecar spawn and
 * the dev command separately, and would be easy to lose. `v8.setFlagsFromString`
 * plus `vm.runInNewContext('gc')` obtains the same function at runtime, verified
 * to actually collect (642 MB → 18 MB in a standalone check). One code path, every
 * launcher.
 *
 * ## Why it is rate-limited
 *
 * A forced major GC is stop-the-world. This project already treats a ~6.7 s
 * `dumpDataDir` block as a serious defect (HS-9239), so an unbounded "collect after
 * every close" would trade an OOM for a stutter. The floor bounds the cost; the
 * pause itself is timed into `freeze.log` like every other blocking operation, so
 * if it is expensive that shows up in the same place everything else does.
 */
import v8 from 'node:v8';
import vm from 'node:vm';

import { instrumentSync } from '../diagnostics/freezeLogger.js';

/** Minimum gap between forced collections. Env: `HOTSHEET_FORCED_GC_MIN_INTERVAL_MS`. */
export function forcedGcMinIntervalMs(): number {
  const raw = process.env.HOTSHEET_FORCED_GC_MIN_INTERVAL_MS;
  if (raw === undefined || raw === '') return 30_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
}

/**
 * HS-9553 — unreclaimed bytes that override the time throttle.
 *
 * Three clusters' worth. Below this, waiting out the interval is the right trade
 * (a stop-the-world pause costs more than ~0.5 GB of briefly-resident WASM heap);
 * at or above it, the memory we are failing to return is itself what triggers the
 * next round of eviction, and waiting makes the problem worse rather than
 * cheaper. Env: `HOTSHEET_FORCED_GC_URGENT_BYTES`.
 */
export function forcedGcUrgentBytes(): number {
  const raw = process.env.HOTSHEET_FORCED_GC_URGENT_BYTES;
  const fallback = 3 * 180 * 1024 * 1024;
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Should a collection run now? Pure, so the throttle is testable without waiting
 * on real time or actually collecting.
 *
 * `lastAt === null` means "never collected" and always passes — the first close
 * after startup should not have to wait out the interval.
 *
 * ## HS-9553: why the time throttle alone was not enough
 *
 * The 30 s floor assumes closes arrive at a human pace. In the 2026-08-01 death
 * they did not. The machine resumed from a 16-minute sleep and the whole periodic
 * world fired at once — the 5-minute backup train, the hourly backup, telemetry
 * ingest, the github scheduled sync, the idle sweep and the headroom guard —
 * churning clusters **~15 times in 2 seconds** (`evictChurn` 125 → 140 in
 * `freeze.log`).
 *
 * The first sweep collected and worked exactly as designed: `external` 2680 →
 * 1127 MB. Every close for the next 30 s was then `'throttled'` and returned
 * nothing, while each reopen allocated a fresh ~180 MB heap. 1.5 seconds later
 * there were **3 clusters open and 4892 MB of external** — ~4.3 GB belonging to
 * clusters that were already closed. That is the docs/128 §128.5.4 runaway with
 * the throttle standing in for the missing collection:
 *
 *     high external -> evict (throttled, frees nothing) -> reopen (+180 MB) -> higher external
 *
 * So the throttle now yields to accumulated debt. This cannot become a
 * collect-on-every-close (the thing the floor exists to prevent): the bypass
 * requires `urgentBytes` of *already-closed, uncollected* heap, which only a
 * burst can produce, and collecting resets the debt to zero.
 */
export function shouldForceGc(
  lastAt: number | null,
  now: number,
  minIntervalMs: number,
  pendingReclaimBytes = 0,
  urgentBytes: number = forcedGcUrgentBytes(),
): boolean {
  if (lastAt === null) return true;
  if (now - lastAt >= minIntervalMs) return true;
  return pendingReclaimBytes >= urgentBytes;
}

let gcFn: (() => void) | null = null;
let looked = false;

/**
 * The collector, or null if this runtime won't give us one. Acquired once and
 * cached; a failure is remembered so we don't retry the flag dance per eviction.
 */
export function getForcedGc(): (() => void) | null {
  if (looked) return gcFn;
  looked = true;
  try {
    // Already present when the process WAS launched with --expose-gc (tests do).
    const existing = (globalThis as unknown as { gc?: () => void }).gc;
    if (typeof existing === 'function') { gcFn = existing; return gcFn; }
    v8.setFlagsFromString('--expose-gc');
    const fn: unknown = vm.runInNewContext('gc');
    gcFn = typeof fn === 'function' ? (fn as () => void) : null;
  } catch {
    gcFn = null; // hardened runtime / flags disallowed — degrade, never throw
  }
  return gcFn;
}

let lastForcedAt: number | null = null;

export type ForceGcResult = 'collected' | 'throttled' | 'unavailable';

/**
 * Collect now if allowed. Returns what happened so the caller can log or count it
 * — a silent no-op here would be indistinguishable from a collection that freed
 * nothing, which is exactly the ambiguity this whole area keeps producing.
 */
export function forceGcNow(
  dataDir: string,
  now: number = Date.now(),
  /** HS-9553 — bytes closed but not yet collected. Past `forcedGcUrgentBytes`
   *  this overrides the time throttle; see `shouldForceGc`. */
  pendingReclaimBytes = 0,
): ForceGcResult {
  const gc = getForcedGc();
  if (gc === null) return 'unavailable';
  if (!shouldForceGc(lastForcedAt, now, forcedGcMinIntervalMs(), pendingReclaimBytes)) return 'throttled';
  lastForcedAt = now;
  // Timed like every other blocking operation, so an expensive pause is visible
  // in freeze.log rather than being a mystery gap.
  instrumentSync(dataDir, 'gc.forced', () => {
    // TWO passes, and this is load-bearing rather than superstition. Measured with
    // ~200 MB of off-heap buffers dropped immediately beforehand:
    //
    //   1 call  -> 194 MB -> 194 MB   (freed NOTHING)
    //   2 calls -> 202 MB ->  10 MB   (freed everything, 10 ms)
    //   3 calls ->            10 MB   (no better, slower)
    //
    // The first collection makes the wrappers unreachable and queues their
    // external-memory finalizers; the second is what actually runs them. Writing
    // the obvious single `gc()` would have shipped a fix that does nothing at all
    // — and looks correct in review.
    //
    // `gc({ type: 'major', execution: 'sync' })` is ACCEPTED on this Node and is
    // NOT a substitute: measured, it freed nothing in one call.
    gc();
    gc();
  });
  return 'collected';
}

/** Test seam — forget the throttle and the cached lookup. */
export function resetForcedGcForTests(): void {
  lastForcedAt = null;
  looked = false;
  gcFn = null;
}
