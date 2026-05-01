// @vitest-environment node
/**
 * HS-8090 — unit tests for `parseJsonArrayOr`.
 */
import { describe, expect, it } from 'vitest';

import { parseJsonArrayOr } from './json.js';

describe('parseJsonArrayOr (HS-8090)', () => {
  it('returns the parsed array when the input is well-formed JSON for an array', () => {
    const result = parseJsonArrayOr('[{"text":"a"},{"text":"b"}]', []);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([{ text: 'a' }, { text: 'b' }]);
  });

  it('returns the fallback for an empty string', () => {
    expect(parseJsonArrayOr('', [])).toEqual([]);
    expect(parseJsonArrayOr('', null)).toBeNull();
  });

  it('returns the fallback for null / undefined input', () => {
    expect(parseJsonArrayOr(null, [])).toEqual([]);
    expect(parseJsonArrayOr(undefined, [])).toEqual([]);
  });

  it('returns the fallback for malformed JSON (no exception escapes)', () => {
    expect(parseJsonArrayOr('not-json', [])).toEqual([]);
    expect(parseJsonArrayOr('{', [])).toEqual([]);
    expect(parseJsonArrayOr('[1, 2,', [])).toEqual([]);
  });

  it('returns the fallback when valid JSON does not deserialise to an array', () => {
    expect(parseJsonArrayOr('{"text": "a"}', [])).toEqual([]);
    expect(parseJsonArrayOr('"plain string"', [])).toEqual([]);
    expect(parseJsonArrayOr('42', [])).toEqual([]);
    expect(parseJsonArrayOr('null', [])).toEqual([]);
    expect(parseJsonArrayOr('true', [])).toEqual([]);
  });

  it('preserves the empty-array case (well-formed `[]` is not a fallback trigger)', () => {
    expect(parseJsonArrayOr('[]', null)).toEqual([]);
  });

  it('does NOT validate per-element shape (caller responsibility)', () => {
    // The helper returns the array as `unknown[]` — element-level
    // validation is intentionally out of scope, since each caller wants
    // a different element shape.
    const result = parseJsonArrayOr('[1, "a", null, {"x": true}]', []) as unknown[];
    expect(result).toHaveLength(4);
    expect(result[0]).toBe(1);
    expect(result[1]).toBe('a');
    expect(result[2]).toBeNull();
    expect(result[3]).toEqual({ x: true });
  });
});
