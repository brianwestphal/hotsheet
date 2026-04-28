/**
 * HS-7972 — `renderTabs()` short-circuits the project-tab DOM rebuild when
 * the inputs haven't changed since the last paint. This file exercises the
 * pure fingerprint helper that gates that short-circuit.
 */
import { describe, expect, it } from 'vitest';

import { computeProjectTabsFingerprint } from './projectTabsFingerprint.js';

describe('computeProjectTabsFingerprint (HS-7972)', () => {
  it('returns the empty/Hot Sheet sentinel when there are no projects', () => {
    expect(computeProjectTabsFingerprint([], null)).toBe('single|Hot Sheet');
  });

  it('returns the single-project name when there is exactly one', () => {
    expect(computeProjectTabsFingerprint([{ secret: 'a', name: 'Alpha' }], 'a')).toBe('single|Alpha');
  });

  it('produces a stable string for two-or-more projects', () => {
    const fp = computeProjectTabsFingerprint(
      [{ secret: 'a', name: 'Alpha' }, { secret: 'b', name: 'Bravo' }],
      'a',
    );
    expect(fp).toBe('a|Alpha|1||b|Bravo|0');
  });

  it('is identical when called twice with the same inputs', () => {
    const projects = [{ secret: 'a', name: 'Alpha' }, { secret: 'b', name: 'Bravo' }];
    expect(computeProjectTabsFingerprint(projects, 'a')).toBe(computeProjectTabsFingerprint(projects, 'a'));
  });

  it('changes when the active secret moves', () => {
    const projects = [{ secret: 'a', name: 'Alpha' }, { secret: 'b', name: 'Bravo' }];
    expect(computeProjectTabsFingerprint(projects, 'a')).not.toBe(computeProjectTabsFingerprint(projects, 'b'));
  });

  it('changes when a project is renamed', () => {
    const before = [{ secret: 'a', name: 'Alpha' }, { secret: 'b', name: 'Bravo' }];
    const after = [{ secret: 'a', name: 'Alpha' }, { secret: 'b', name: 'Bravissimo' }];
    expect(computeProjectTabsFingerprint(before, 'a')).not.toBe(computeProjectTabsFingerprint(after, 'a'));
  });

  it('changes when projects are reordered', () => {
    const before = [{ secret: 'a', name: 'Alpha' }, { secret: 'b', name: 'Bravo' }];
    const after = [{ secret: 'b', name: 'Bravo' }, { secret: 'a', name: 'Alpha' }];
    expect(computeProjectTabsFingerprint(before, 'a')).not.toBe(computeProjectTabsFingerprint(after, 'a'));
  });

  it('changes when a new project is added', () => {
    const before = [{ secret: 'a', name: 'Alpha' }, { secret: 'b', name: 'Bravo' }];
    const after = [...before, { secret: 'c', name: 'Charlie' }];
    expect(computeProjectTabsFingerprint(before, 'a')).not.toBe(computeProjectTabsFingerprint(after, 'a'));
  });

  it('changes when an existing project is removed', () => {
    const before = [{ secret: 'a', name: 'Alpha' }, { secret: 'b', name: 'Bravo' }];
    const after = [{ secret: 'a', name: 'Alpha' }];
    expect(computeProjectTabsFingerprint(before, 'a')).not.toBe(computeProjectTabsFingerprint(after, 'a'));
  });

  it('produces different fingerprints for "single" vs "many" with the same name', () => {
    const single = computeProjectTabsFingerprint([{ secret: 'a', name: 'Alpha' }], 'a');
    const many = computeProjectTabsFingerprint(
      [{ secret: 'a', name: 'Alpha' }, { secret: 'b', name: 'Beta' }],
      'a',
    );
    expect(single).not.toBe(many);
  });
});
