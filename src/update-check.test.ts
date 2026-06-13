/**
 * `compareVersions` — the gate behind the npm→Tauri update nudge (an update is
 * offered only when current is older than latest). The semantics: compare the
 * first three numeric components, treating missing / non-numeric components as 0.
 */
import { describe, expect, it } from 'vitest';

import { compareVersions } from './update-check.js';

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('returns -1 when current is older (an update is available)', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
    expect(compareVersions('1.2.3', '1.3.0')).toBe(-1);
    expect(compareVersions('1.2.3', '2.0.0')).toBe(-1);
  });

  it('returns 1 when current is newer', () => {
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
  });

  it('compares numerically, not lexically (10 > 9)', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
  });

  it('treats missing trailing components as 0', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.1')).toBe(-1);
  });

  it('parses a non-numeric component to 0 (so 1.2.3-beta sorts as 1.2.0, below 1.2.3)', () => {
    expect(compareVersions('1.2.3-beta', '1.2.3')).toBe(-1);
    expect(compareVersions('1.2.3-beta', '1.2.0')).toBe(0);
  });

  it('only considers the first three components', () => {
    expect(compareVersions('1.2.3.9', '1.2.3.1')).toBe(0);
  });
});
