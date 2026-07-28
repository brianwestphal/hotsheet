/**
 * HS-9451 — spread-safe array helpers.
 *
 * `f(...arr)` passes every element as a separate ARGUMENT, and an engine's argument
 * count is bounded by the call stack. Past that bound V8 throws
 * `RangeError: Maximum call stack size exceeded` — the same message a runaway
 * recursion produces, which is what makes this so confusing to diagnose: there is no
 * recursion anywhere in the stack trace, and the code is usually a one-liner that
 * has worked for months. It only starts failing once the data crosses the limit, and
 * from then on it fails EVERY time.
 *
 * Measured on this project's Node (22.14, arm64): `out.push(...arr)` and
 * `Math.max(...arr)` both succeed at 100,000 elements and throw at 125,000. Treat
 * anything that can grow unbounded — telemetry spans/events, tickets, sync records —
 * as over the line, because the threshold is not a spec guarantee and shifts with
 * stack depth at the call site.
 *
 * Use these instead of spreading. They are O(n) and allocate nothing extra.
 */

/** `target.push(...source)` without the argument-count limit. */
export function pushAll<T>(target: T[], source: readonly T[]): void {
  for (const item of source) target.push(item);
}

/** `Math.max(...values)` without the argument-count limit. Null for an empty input,
 *  which is also a safer shape than `Math.max()`'s `-Infinity`. */
export function maxOf(values: readonly number[]): number | null {
  let max: number | null = null;
  for (const v of values) if (max === null || v > max) max = v;
  return max;
}

/** `Math.min(...values)` without the argument-count limit. Null for an empty input. */
export function minOf(values: readonly number[]): number | null {
  let min: number | null = null;
  for (const v of values) if (min === null || v < min) min = v;
  return min;
}
