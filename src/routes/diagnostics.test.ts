/**
 * HS-8054 v3 — `coerceFreezeEntry` validation. Asserts the route's
 * input-shape gate keeps malformed payloads out of `freeze.log`.
 */
import { describe, expect, it } from 'vitest';

import { coerceFreezeEntry } from './diagnostics.js';

describe('coerceFreezeEntry (HS-8054 v3)', () => {
  it('accepts a well-formed client-observer entry', () => {
    const out = coerceFreezeEntry({
      ts: '2026-05-04T08:00:00.000Z',
      source: 'client-observer',
      durationMs: 723,
      context: 'project-switch:Hot Sheet',
      clientWallClock: '08:00:00.123',
    });
    expect(out).not.toBeNull();
    expect(out!.source).toBe('client-observer');
    expect(out!.durationMs).toBe(723);
    expect(out!.context).toBe('project-switch:Hot Sheet');
    expect(out!.clientWallClock).toBe('08:00:00.123');
  });

  it('accepts a well-formed client-heartbeat entry', () => {
    const out = coerceFreezeEntry({
      ts: '2026-05-04T08:00:00.000Z',
      source: 'client-heartbeat',
      durationMs: 1240,
      context: 'no recent interactions',
    });
    expect(out).not.toBeNull();
    expect(out!.source).toBe('client-heartbeat');
  });

  it('rounds non-integer durations to integers', () => {
    const out = coerceFreezeEntry({
      ts: '2026-05-04T08:00:00.000Z',
      source: 'client-observer',
      durationMs: 723.7,
      context: '',
    });
    expect(out!.durationMs).toBe(724);
  });

  it('falls back to a server-side timestamp when ts is missing', () => {
    const out = coerceFreezeEntry({
      source: 'client-observer',
      durationMs: 200,
      context: 'foo',
    });
    expect(out!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('rejects null / non-object inputs', () => {
    expect(coerceFreezeEntry(null)).toBeNull();
    expect(coerceFreezeEntry(undefined)).toBeNull();
    expect(coerceFreezeEntry('string')).toBeNull();
    expect(coerceFreezeEntry(42)).toBeNull();
    expect(coerceFreezeEntry([])).toBeNull();
  });

  it('rejects unknown source values (server tags must be server-produced)', () => {
    expect(coerceFreezeEntry({ source: 'server-heartbeat', durationMs: 100, context: '' })).toBeNull();
    expect(coerceFreezeEntry({ source: 'made-up', durationMs: 100, context: '' })).toBeNull();
    expect(coerceFreezeEntry({ source: '', durationMs: 100, context: '' })).toBeNull();
  });

  it('rejects malformed durationMs values', () => {
    expect(coerceFreezeEntry({ source: 'client-observer', durationMs: -1, context: '' })).toBeNull();
    expect(coerceFreezeEntry({ source: 'client-observer', durationMs: NaN, context: '' })).toBeNull();
    expect(coerceFreezeEntry({ source: 'client-observer', durationMs: 'fast', context: '' })).toBeNull();
    expect(coerceFreezeEntry({ source: 'client-observer', context: '' })).toBeNull();
  });

  it('preserves the optional extra field when it is a plain object', () => {
    const out = coerceFreezeEntry({
      source: 'client-observer',
      durationMs: 100,
      context: '',
      extra: { stack: 'somewhere', tabs: 12 },
    });
    expect(out!.extra).toEqual({ stack: 'somewhere', tabs: 12 });
  });

  it('drops a non-object extra field rather than letting it through', () => {
    const out = coerceFreezeEntry({
      source: 'client-observer',
      durationMs: 100,
      context: '',
      extra: 'not an object',
    });
    expect(out!.extra).toBeUndefined();
  });
});
