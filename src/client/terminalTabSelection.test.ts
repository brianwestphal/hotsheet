import { describe, expect, it } from 'vitest';

import { pickNearestTerminalTabId } from './terminalTabSelection.js';

describe('pickNearestTerminalTabId', () => {
  it('returns null when no ids were closed', () => {
    expect(pickNearestTerminalTabId(['a', 'b', 'c'], [])).toBe(null);
  });

  it('returns the first surviving tab to the right of the first closed tab', () => {
    expect(pickNearestTerminalTabId(['a', 'b', 'c', 'd'], ['b'])).toBe('c');
  });

  it('falls back to the left when no surviving tab exists to the right', () => {
    expect(pickNearestTerminalTabId(['a', 'b', 'c'], ['c'])).toBe('b');
  });

  it('skips closed tabs while walking right', () => {
    expect(pickNearestTerminalTabId(['a', 'b', 'c', 'd', 'e'], ['b', 'c'])).toBe('d');
  });

  it('skips closed tabs while walking left when nothing survives to the right', () => {
    expect(pickNearestTerminalTabId(['a', 'b', 'c', 'd'], ['c', 'd'])).toBe('b');
  });

  it('anchors on the first closed tab, not the earliest-in-the-list closure', () => {
    // Order: a b c d e; closed set { d, b }. First closed in snapshot is b.
    // Walking right from b: c survives → pick c.
    expect(pickNearestTerminalTabId(['a', 'b', 'c', 'd', 'e'], ['d', 'b'])).toBe('c');
  });

  it('returns null when every tab in the snapshot was closed', () => {
    expect(pickNearestTerminalTabId(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(null);
  });

  it('returns null when the closed id is not present in the snapshot', () => {
    expect(pickNearestTerminalTabId(['a', 'b', 'c'], ['x'])).toBe(null);
  });

  it('handles a single-tab snapshot', () => {
    expect(pickNearestTerminalTabId(['a'], ['a'])).toBe(null);
  });

  it('walks rightward past multiple closed neighbours before taking the leftward fallback', () => {
    // Order: a b c d; closed set { c, d }. First closed is c. Walk right: d
    // is closed, end of list. Walk left: b survives.
    expect(pickNearestTerminalTabId(['a', 'b', 'c', 'd'], ['c', 'd'])).toBe('b');
  });
});
