/**
 * HS-9469 (docs/131) — how tight is memory on the MACHINE, not just in this process?
 *
 * `clusterBudget` (docs/128 §128.2.1) sizes the PGLite cluster cache from
 * `external` against V8's heap ceiling. That is exactly right for the failure it
 * was built for — the 2026-07-24 OOM was V8's own limit — and it is free and
 * synchronous. It is also completely blind to the rest of the computer. If the
 * machine is swapping because of Xcode, a VM, or a browser with 200 tabs, Hot
 * Sheet cheerfully holds ten clusters open because *its* headroom looks fine, and
 * makes the problem worse.
 *
 * ## A level, not a number
 *
 * This reports `normal | warn | critical` rather than bytes, because bytes do not
 * mean the same thing on different platforms and the OS already knows the answer
 * better than we can compute it. macOS publishes a pressure level directly;
 * Linux publishes stall time, which is a far better signal than free bytes. Only
 * the last-resort fallback works in bytes, and it is deliberately generous
 * because it is the least trustworthy of the three.
 *
 * ## Why `os.freemem()` is not the implementation
 *
 * It is portable, free, and wrong. On macOS "free" excludes purgeable and
 * file-backed pages, so a perfectly healthy machine routinely reports a few
 * hundred MB free out of 32 GB. Believing that number would keep the cache at its
 * floor permanently — the cure being much worse than the disease. It is used only
 * where nothing better exists, at a threshold low enough that a false alarm is
 * unlikely.
 *
 * ## Reacting fast, relaxing slowly
 *
 * Pressure is read from a cached sample (`SAMPLE_TTL_MS`), never per call — the
 * budget is recomputed on every cluster open and every sweep, and shelling out
 * that often would be worse than the problem being solved.
 *
 * The asymmetry in `applyHysteresis` is the important part: an INCREASE in
 * pressure is adopted immediately, a DECREASE has to survive `EASE_SAMPLES`
 * consecutive readings. Memory pressure is spiky, and following every dip back
 * down would reopen clusters that are about to be evicted again — churn, which
 * HS-9470's `evictChurn` counter now makes visible. Being slow to relax costs a
 * little cache; being quick to relax costs thrashing during exactly the period
 * when reopens are most expensive.
 */
import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/** The OS's verdict, normalized across platforms. */
export type SystemPressureLevel = 'normal' | 'warn' | 'critical';

/** How long a sample is reused before another is taken. */
export const SAMPLE_TTL_MS = 15_000;

/** Consecutive calmer samples required before easing off. See the header. */
export const EASE_SAMPLES = 3;

/** Probe timeout — a wedged `sysctl` must never hold up an eviction decision. */
const PROBE_TIMEOUT_MS = 2_000;

// ── Pure parsers (one per platform) ────────────────────────────────────────

/**
 * macOS `sysctl -n kern.memorystatus_vm_pressure_level` → 1 normal, 2 warn,
 * 4 critical. This is the kernel's own verdict, which is why it is preferred over
 * anything we could compute from page counts.
 */
export function parseMacPressureLevel(raw: string): SystemPressureLevel | null {
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return null;
  if (n >= 4) return 'critical';
  if (n >= 2) return 'warn';
  if (n >= 1) return 'normal';
  return null;
}

/**
 * Linux PSI (`/proc/pressure/memory`) — the `some avg10` figure is the percentage
 * of the last 10 s in which at least one task stalled on memory. Stall time is a
 * much better signal than free bytes: a machine can have little "free" memory and
 * be perfectly happy, but it cannot be stalling and be happy.
 *
 * Thresholds are deliberately low. Any sustained memory stalling is already bad.
 */
export function parseLinuxPsi(raw: string): SystemPressureLevel | null {
  const line = raw.split('\n').find((l) => l.startsWith('some '));
  if (line === undefined) return null;
  const match = /avg10=([0-9.]+)/.exec(line);
  if (match === null) return null;
  const avg10 = Number(match[1]);
  if (!Number.isFinite(avg10)) return null;
  if (avg10 >= 20) return 'critical';
  if (avg10 >= 5) return 'warn';
  return 'normal';
}

/**
 * Last-resort fallback from free/total bytes. Generous on purpose: this runs
 * where we have no trustworthy signal, and `freemem` under-reports badly on some
 * platforms, so it only fires when things look genuinely dire.
 */
export function levelFromFreeRatio(freeBytes: number, totalBytes: number): SystemPressureLevel {
  if (totalBytes <= 0) return 'normal';
  const free = freeBytes / totalBytes;
  if (free <= 0.02) return 'critical';
  if (free <= 0.08) return 'warn';
  return 'normal';
}

const ORDER: Record<SystemPressureLevel, number> = { normal: 0, warn: 1, critical: 2 };

/**
 * Adopt an increase at once; require `EASE_SAMPLES` consecutive calmer readings
 * before adopting a decrease. Returns the level to use plus the updated run of
 * consecutive calmer samples.
 *
 * Pure, so the asymmetry is testable without waiting on real time.
 */
export function applyHysteresis(
  current: SystemPressureLevel,
  sampled: SystemPressureLevel,
  calmerRun: number,
): { level: SystemPressureLevel; calmerRun: number } {
  if (ORDER[sampled] > ORDER[current]) return { level: sampled, calmerRun: 0 };
  if (ORDER[sampled] === ORDER[current]) return { level: current, calmerRun: 0 };
  const run = calmerRun + 1;
  if (run >= EASE_SAMPLES) return { level: sampled, calmerRun: 0 };
  return { level: current, calmerRun: run };
}

// ── Sampling ───────────────────────────────────────────────────────────────

/**
 * Take one reading. Never throws: a probe that fails or times out returns
 * `normal`, which means "add no extra constraint" and leaves the process-level
 * guard exactly as it was. A broken probe must not shrink the cache.
 */
export async function sampleSystemPressure(platform: string = process.platform): Promise<SystemPressureLevel> {
  try {
    if (platform === 'darwin') {
      const { stdout } = await execAsync('sysctl -n kern.memorystatus_vm_pressure_level', { timeout: PROBE_TIMEOUT_MS });
      return parseMacPressureLevel(stdout) ?? levelFromFreeRatio(os.freemem(), os.totalmem());
    }
    if (platform === 'linux') {
      const raw = await readFile('/proc/pressure/memory', 'utf8');
      return parseLinuxPsi(raw) ?? levelFromFreeRatio(os.freemem(), os.totalmem());
    }
    // Windows and anything else: no cheap kernel verdict available, so the
    // generous free-ratio fallback. Better than pretending we know.
    return levelFromFreeRatio(os.freemem(), os.totalmem());
  } catch {
    return 'normal';
  }
}

let cached: SystemPressureLevel = 'normal';
let cachedAt = 0;
let calmerRun = 0;
let inFlight: Promise<void> | null = null;

/**
 * The current level, cheap and synchronous.
 *
 * Returns the last sample and kicks off a refresh in the background when it has
 * gone stale. Deliberately never awaits the probe: this is called from the
 * eviction path, and an eviction decision must not wait on a subprocess. The cost
 * of acting on a reading up to `SAMPLE_TTL_MS` old is one sweep interval of
 * lag — far cheaper than blocking.
 */
export function currentSystemPressure(now: number = Date.now()): SystemPressureLevel {
  if (now - cachedAt >= SAMPLE_TTL_MS && inFlight === null) {
    cachedAt = now; // stamp first, so a slow probe can't queue a second one
    inFlight = sampleSystemPressure()
      .then((sampled) => {
        const next = applyHysteresis(cached, sampled, calmerRun);
        cached = next.level;
        calmerRun = next.calmerRun;
      })
      .catch(() => { /* sampleSystemPressure already swallows; belt and braces */ })
      .finally(() => { inFlight = null; });
  }
  return cached;
}

/** Test seam — forget the cached sample and hysteresis state. */
export function resetSystemPressureForTests(): void {
  cached = 'normal';
  cachedAt = 0;
  calmerRun = 0;
  inFlight = null;
}
