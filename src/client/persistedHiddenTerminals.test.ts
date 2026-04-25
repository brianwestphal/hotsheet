import { describe, expect, it } from 'vitest';

import { isConfiguredTerminalId } from './dashboardHiddenTerminals.js';
import { computePersistedIds } from './persistedHiddenTerminals.js';

/**
 * HS-7825 — pure-helper tests for the persistence layer of the
 * configured-terminal hidden state. The DOM-touching paths
 * (`initPersistedHiddenTerminals`) are exercised by e2e flows and the
 * existing dashboardHiddenTerminals tests; these focus on the filter logic
 * that decides what makes it into settings.json.
 */
describe('isConfiguredTerminalId (HS-7825)', () => {
  it('returns true for a settings-backed terminal id', () => {
    expect(isConfiguredTerminalId('default')).toBe(true);
    expect(isConfiguredTerminalId('default-1')).toBe(true);
    expect(isConfiguredTerminalId('claude')).toBe(true);
  });

  it('returns false for runtime-generated dynamic terminal ids', () => {
    expect(isConfiguredTerminalId('dyn-abc-123')).toBe(false);
    expect(isConfiguredTerminalId('dyn-moews3gs-i9y3oh')).toBe(false);
  });

  it('treats an id that contains "dyn-" but does not start with it as configured', () => {
    expect(isConfiguredTerminalId('mydyn-test')).toBe(true);
  });

  it('returns true for an empty id (defensive — caller is responsible for not feeding empty)', () => {
    expect(isConfiguredTerminalId('')).toBe(true);
  });
});

describe('computePersistedIds (HS-7825)', () => {
  it('returns an empty array when the hidden set is empty', () => {
    expect(computePersistedIds(new Set())).toEqual([]);
  });

  it('strips dynamic ids and returns the configured-only subset sorted', () => {
    const set = new Set(['default', 'dyn-abc', 'claude', 'dyn-xyz', 'shell']);
    expect(computePersistedIds(set)).toEqual(['claude', 'default', 'shell']);
  });

  it('sorts the output so byte-equal serialised payloads are stable', () => {
    const a = new Set(['z', 'a', 'm']);
    const b = new Set(['m', 'a', 'z']);
    expect(JSON.stringify(computePersistedIds(a)))
      .toEqual(JSON.stringify(computePersistedIds(b)));
  });

  it('returns an empty array when the only hidden ids are dynamic', () => {
    const set = new Set(['dyn-1', 'dyn-2']);
    expect(computePersistedIds(set)).toEqual([]);
  });
});
