// HS-9522 — one-shot "is this CLI installed / what version" probes, off the event loop.
//
// HS-9518 *bounded* these calls (`timeout` + `killSignal: 'SIGKILL'`), turning "blocks
// forever" into "blocks for up to N seconds". That is the difference between a watchdog
// SIGKILL and a stutter, but it is a floor rather than a fix: `execFileSync` blocks the
// calling thread inside NATIVE code, so on an HTTP handler it stops the whole event
// loop — no other request is served for the duration.
//
// Neither probe needs to be synchronous. Both handlers are already `async`.
//
// Two probes wanted the same three things (async spawn, short TTL, in-flight
// coalescing), so it lives here rather than being written twice — the docs/132 §132.9.1
// rule of thumb, applied outside the AI-tool layer.
//
// ## Why a TTL and not a permanent cache
//
// HS-8786 deliberately removed a permanent cache: a user who fixed their PATH or
// installed the CLI had to restart the server before Hot Sheet noticed, which is a
// baffling experience. A short TTL keeps that property — a fix is picked up within
// seconds — while collapsing a burst of polling into one spawn instead of one spawn per
// request. The old shape spawned a process on *every* `/glassbox/status` call.

import { execFileAsync } from './execAsync.js';

/** How long a probe result is reused. Short enough that installing the CLI is noticed
 *  almost immediately; long enough that a polling client doesn't spawn per tick. */
export const PROBE_TTL_MS = 10_000;

interface CacheEntry<T> {
  value: T;
  at: number;
}

/** Extra spawn options a probe needs. `env` matters: the glassbox probe searches an
 *  AUGMENTED PATH, and losing it would silently stop finding a CLI that is installed. */
export interface ProbeRunOptions {
  env?: NodeJS.ProcessEnv;
}

export interface ProbeDeps {
  now?: () => number;
  /** Injected for tests; defaults to the real async spawn. */
  run?: (file: string, args: readonly string[], timeoutMs: number, options?: ProbeRunOptions) => Promise<string>;
}

async function defaultRun(file: string, args: readonly string[], timeoutMs: number, options: ProbeRunOptions = {}): Promise<string> {
  // `killSignal` alongside `timeout` for the HS-9391 reason: a timeout is enforced by
  // SENDING the signal, and the default SIGTERM can be ignored. Async here, so a hung
  // child costs a pending promise rather than a stopped event loop — but bounding it
  // still matters, or the child itself leaks.
  const { stdout } = await execFileAsync(file, args, {
    timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf-8', ...options,
  });
  return stdout.trim();
}

/**
 * Build a cached, coalesced, async probe.
 *
 * `compute` runs at most once per TTL, and concurrent callers during an in-flight run
 * share that one promise — N simultaneous requests spawn one child, not N.
 *
 * A REJECTED probe is not cached: a transient failure (a stalled mount, a momentarily
 * missing binary) would otherwise be pinned for the whole TTL, which is the opposite of
 * what a short TTL is for.
 */
export function createCachedProbe<T>(compute: (deps: Required<ProbeDeps>) => Promise<T>, deps: ProbeDeps = {}): {
  get: () => Promise<T>;
  reset: () => void;
} {
  const resolved: Required<ProbeDeps> = { now: deps.now ?? Date.now, run: deps.run ?? defaultRun };
  let cache: CacheEntry<T> | null = null;
  let inFlight: Promise<T> | null = null;

  return {
    get: async (): Promise<T> => {
      const now = resolved.now();
      if (cache !== null && now - cache.at < PROBE_TTL_MS) return cache.value;
      if (inFlight !== null) return inFlight; // coalesce — one child for N callers
      inFlight = compute(resolved)
        .then((value) => {
          cache = { value, at: resolved.now() };
          return value;
        })
        .finally(() => { inFlight = null; });
      return inFlight;
    },
    reset: (): void => { cache = null; inFlight = null; },
  };
}

/** Run a bounded CLI probe, returning null instead of throwing when it fails —
 *  "not installed" and "the probe broke" are the same answer to every caller here. */
export async function probeCli(
  deps: Required<ProbeDeps>,
  file: string,
  args: readonly string[],
  timeoutMs: number,
  options?: ProbeRunOptions,
): Promise<string | null> {
  try {
    // Trim HERE, not only in `defaultRun`: the runner is injectable, and an
    // emptiness check that depends on who produced the string is a check that
    // silently stops working the moment someone supplies their own runner.
    const out = (await deps.run(file, args, timeoutMs, options)).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}
