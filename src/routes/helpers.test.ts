import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';

import { parseIntParam } from './helpers.js';

/** Minimal Context stub exposing only `c.req.param(name)`, which is all
 *  `parseIntParam` reads. */
function ctx(params: Record<string, string | undefined>): Context {
  return { req: { param: (p: string) => params[p] } } as unknown as Context;
}

describe('parseIntParam', () => {
  it('parses a valid integer for the default "id" param', () => {
    expect(parseIntParam(ctx({ id: '42' }))).toBe(42);
  });

  it('reads a custom param name', () => {
    expect(parseIntParam(ctx({ ticketId: '7' }), 'ticketId')).toBe(7);
  });

  it('returns null when the param is missing', () => {
    expect(parseIntParam(ctx({}))).toBeNull();
  });

  it('returns null for a non-numeric value', () => {
    expect(parseIntParam(ctx({ id: 'abc' }))).toBeNull();
  });

  it('parses the leading integer of a mixed value (parseInt semantics)', () => {
    expect(parseIntParam(ctx({ id: '12px' }))).toBe(12);
  });

  it('handles negative integers', () => {
    expect(parseIntParam(ctx({ id: '-5' }))).toBe(-5);
  });
});
