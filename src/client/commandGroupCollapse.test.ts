// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetGroupCollapseForTesting,
  groupCollapseKey,
  isGroupCollapsed,
  setGroupCollapsed,
} from './commandGroupCollapse.js';
import type { CommandGroup } from './experimentalSettings.js';

const group = (over: Partial<CommandGroup> = {}): CommandGroup => ({
  type: 'group', name: 'My Group', children: [], ...over,
});

describe('commandGroupCollapse (HS-9095)', () => {
  afterEach(() => { _resetGroupCollapseForTesting(); });

  it('keys by id when present, else by name, scoped by secret', () => {
    expect(groupCollapseKey('s1', group({ id: 'g1' }))).toBe('s1::g1');
    expect(groupCollapseKey('s1', group({ id: '' }))).toBe('s1::My Group');
    expect(groupCollapseKey('s2', group({ id: 'g1' }))).toBe('s2::g1');
  });

  it('defaults to NOT collapsed when nothing is stored and no legacy field', () => {
    expect(isGroupCollapsed('s1', group({ id: 'g1' }))).toBe(false);
  });

  it('falls back to the legacy `collapsed` field when no stored entry (migration)', () => {
    expect(isGroupCollapsed('s1', group({ id: 'g1', collapsed: true }))).toBe(true);
    expect(isGroupCollapsed('s1', group({ id: 'g1', collapsed: false }))).toBe(false);
  });

  it('round-trips set → get; a stored value wins over the legacy field', () => {
    const g = group({ id: 'g1', collapsed: true });
    setGroupCollapsed('s1', g, false); // user expanded a legacy-collapsed group
    expect(isGroupCollapsed('s1', g)).toBe(false);
    setGroupCollapsed('s1', g, true);
    expect(isGroupCollapsed('s1', g)).toBe(true);
  });

  it('is scoped per project secret', () => {
    const g = group({ id: 'g1' });
    setGroupCollapsed('s1', g, true);
    expect(isGroupCollapsed('s1', g)).toBe(true);
    expect(isGroupCollapsed('s2', g)).toBe(false); // different project, independent state
  });

  it('does NOT mutate the group object (collapse is out of the tree)', () => {
    const g = group({ id: 'g1' });
    setGroupCollapsed('s1', g, true);
    expect(g.collapsed).toBeUndefined();
  });
});
