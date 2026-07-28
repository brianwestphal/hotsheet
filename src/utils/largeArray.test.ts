/**
 * HS-9451 — the spread-into-call hazard these helpers exist to avoid.
 *
 * The failure is `RangeError: Maximum call stack size exceeded`, which reads like a
 * runaway recursion but isn't: `f(...arr)` passes each element as an argument, and
 * the argument count is bounded by the stack. Measured on Node 22.14/arm64, the
 * boundary sits between 100k and 125k, so these tests use 130k — comfortably over on
 * this engine while staying fast (~ms) and allocation-cheap.
 */
import { describe, expect, it } from 'vitest';

import { maxOf, minOf, pushAll } from './largeArray.js';

/** Over the measured limit; the exact number is not a spec guarantee. */
const OVER_LIMIT = 130_000;

describe('the hazard itself (why these helpers exist)', () => {
  it('spreading an over-limit array into push() really does throw RangeError', () => {
    const big = new Array<number>(OVER_LIMIT).fill(1);
    expect(() => { const out: number[] = []; out.push(...big); })
      .toThrow(/Maximum call stack size exceeded/);
  });
});

describe('pushAll', () => {
  it('appends an over-limit array without throwing', () => {
    const out: number[] = [];
    pushAll(out, new Array<number>(OVER_LIMIT).fill(7));
    expect(out).toHaveLength(OVER_LIMIT);
    expect(out[0]).toBe(7);
    expect(out[OVER_LIMIT - 1]).toBe(7);
  });

  it('appends rather than replacing, preserving order', () => {
    const out = [1, 2];
    pushAll(out, [3, 4]);
    expect(out).toEqual([1, 2, 3, 4]);
  });

  it('is a no-op for an empty source', () => {
    const out = [1];
    pushAll(out, []);
    expect(out).toEqual([1]);
  });
});

describe('maxOf / minOf', () => {
  it('handle an over-limit array without throwing', () => {
    const values = new Array<number>(OVER_LIMIT).fill(5);
    values[1234] = 99;
    values[5678] = -99;
    expect(maxOf(values)).toBe(99);
    expect(minOf(values)).toBe(-99);
  });

  it('agree with Math.max / Math.min on a small array', () => {
    const v = [3, -1, 7, 0];
    expect(maxOf(v)).toBe(Math.max(...v));
    expect(minOf(v)).toBe(Math.min(...v));
  });

  // Math.max() returns -Infinity for no args, which silently poisons arithmetic
  // downstream; null forces the caller to decide.
  it('return null for an empty input rather than ±Infinity', () => {
    expect(maxOf([])).toBeNull();
    expect(minOf([])).toBeNull();
  });

  it('handle a single element and negative-only input', () => {
    expect(maxOf([42])).toBe(42);
    expect(minOf([42])).toBe(42);
    expect(maxOf([-5, -2, -9])).toBe(-2);
    expect(minOf([-5, -2, -9])).toBe(-9);
  });
});
