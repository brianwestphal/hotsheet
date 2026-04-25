import { describe, expect, it } from 'vitest';

import {
  configuredSubsetInStripOrder,
  reorderConfigsById,
  reorderIds,
} from './terminalTabReorder.js';

/**
 * HS-7827 — pure-helper tests for the drawer-terminal-tab reorder flow.
 */
describe('reorderIds (HS-7827)', () => {
  it('moves fromId before toId when dragging right-to-left', () => {
    expect(reorderIds(['a', 'b', 'c', 'd'], 'd', 'a')).toEqual(['d', 'a', 'b', 'c']);
  });

  it('moves fromId after toId when dragging left-to-right', () => {
    expect(reorderIds(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('is a no-op when fromId === toId', () => {
    expect(reorderIds(['a', 'b', 'c'], 'b', 'b')).toEqual(['a', 'b', 'c']);
  });

  it('returns the original order when fromId is missing', () => {
    expect(reorderIds(['a', 'b'], 'unknown', 'a')).toEqual(['a', 'b']);
  });

  it('returns the original order when toId is missing', () => {
    expect(reorderIds(['a', 'b'], 'a', 'unknown')).toEqual(['a', 'b']);
  });

  it('drag adjacent left-to-right swaps the two', () => {
    expect(reorderIds(['a', 'b', 'c'], 'a', 'b')).toEqual(['b', 'a', 'c']);
  });

  it('drag adjacent right-to-left swaps the two', () => {
    expect(reorderIds(['a', 'b', 'c'], 'b', 'a')).toEqual(['b', 'a', 'c']);
  });
});

describe('configuredSubsetInStripOrder (HS-7827)', () => {
  it('returns configured ids in their strip order, dropping dynamic-only ids', () => {
    expect(configuredSubsetInStripOrder(
      ['default', 'dyn-abc', 'claude', 'dyn-xyz'],
      ['default', 'claude'],
    )).toEqual(['default', 'claude']);
  });

  it('reflects the new strip order onto the configured subset', () => {
    expect(configuredSubsetInStripOrder(
      ['claude', 'dyn-abc', 'default'],
      ['default', 'claude'],
    )).toEqual(['claude', 'default']);
  });

  it('appends canonical ids that are missing from the strip at the end (defense in depth)', () => {
    expect(configuredSubsetInStripOrder(
      ['claude'],
      ['default', 'claude'],
    )).toEqual(['claude', 'default']);
  });

  it('handles empty strip order — returns the canonical list verbatim', () => {
    expect(configuredSubsetInStripOrder([], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('handles empty canonical list — returns empty regardless of strip', () => {
    expect(configuredSubsetInStripOrder(['default', 'dyn-abc'], [])).toEqual([]);
  });
});

describe('reorderConfigsById (HS-7827)', () => {
  it('reorders config objects to match the id order', () => {
    const configs = [
      { id: 'a', command: 'cmd-a' },
      { id: 'b', command: 'cmd-b' },
      { id: 'c', command: 'cmd-c' },
    ];
    expect(reorderConfigsById(configs, ['c', 'a', 'b'])).toEqual([
      { id: 'c', command: 'cmd-c' },
      { id: 'a', command: 'cmd-a' },
      { id: 'b', command: 'cmd-b' },
    ]);
  });

  it('appends configs whose id is missing from the id order', () => {
    const configs = [
      { id: 'a', command: 'cmd-a' },
      { id: 'b', command: 'cmd-b' },
    ];
    expect(reorderConfigsById(configs, ['a'])).toEqual([
      { id: 'a', command: 'cmd-a' },
      { id: 'b', command: 'cmd-b' },
    ]);
  });

  it('drops ids in the order list that don\'t correspond to any config', () => {
    const configs = [{ id: 'a', command: 'cmd-a' }];
    expect(reorderConfigsById(configs, ['unknown', 'a'])).toEqual([
      { id: 'a', command: 'cmd-a' },
    ]);
  });

  it('preserves all config fields verbatim (generic shape)', () => {
    interface Full { id: string; name?: string; command: string; lazy?: boolean }
    const configs: Full[] = [
      { id: 'a', name: 'Alpha', command: 'echo a', lazy: false },
      { id: 'b', name: 'Beta', command: 'echo b', lazy: true },
    ];
    const out = reorderConfigsById<Full>(configs, ['b', 'a']);
    expect(out[0]).toEqual({ id: 'b', name: 'Beta', command: 'echo b', lazy: true });
    expect(out[1]).toEqual({ id: 'a', name: 'Alpha', command: 'echo a', lazy: false });
  });
});
