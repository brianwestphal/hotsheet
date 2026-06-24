import { describe, expect, it } from 'vitest';

import {
  resolveFieldScope,
  scopedDisplayValue,
  summarizeValue,
} from './settingsSharing.js';

describe('summarizeValue', () => {
  it('renders an em dash for empty values', () => {
    expect(summarizeValue('text', undefined)).toBe('—');
    expect(summarizeValue('text', null)).toBe('—');
    expect(summarizeValue('text', '')).toBe('—');
  });
  it('renders booleans as On/Off (native or string)', () => {
    expect(summarizeValue('boolean', true)).toBe('On');
    expect(summarizeValue('boolean', false)).toBe('Off');
    expect(summarizeValue('boolean', 'true')).toBe('On');
  });
  it('summarizes arrays and objects by size', () => {
    expect(summarizeValue('complex', [1, 2, 3])).toBe('3 items');
    expect(summarizeValue('complex', [1])).toBe('1 item');
    expect(summarizeValue('complex', { a: 1, b: 2 })).toBe('2 fields');
  });
  it('stringifies scalars', () => {
    expect(summarizeValue('text', 'hello')).toBe('hello');
    expect(summarizeValue('number', 4174)).toBe('4174');
  });
});

describe('resolveFieldScope', () => {
  const layered = {
    shared: { appName: 'Team', backupDir: '/team/default', port: 4190 },
    local: { backupDir: '/me/local', port: 4180 },
    resolved: { appName: 'Team', backupDir: '/me/local', port: 4180 },
  };

  it('marks a shared-only key as origin shared, not overridden', () => {
    const s = resolveFieldScope(layered, 'appName');
    expect(s.origin).toBe('shared');
    expect(s.inShared).toBe(true);
    expect(s.overridden).toBe(false);
  });

  it('marks a key present in both layers as overridden, origin local (local wins)', () => {
    const s = resolveFieldScope(layered, 'backupDir');
    expect(s.overridden).toBe(true);
    expect(s.origin).toBe('local');
    expect(s.sharedValue).toBe('/team/default');
    expect(s.localValue).toBe('/me/local');
    expect(s.resolvedValue).toBe('/me/local');
  });

  it('marks a key absent from both layers as origin default', () => {
    const s = resolveFieldScope(layered, 'ticketPrefix');
    expect(s.origin).toBe('default');
    expect(s.overridden).toBe(false);
    expect(s.inShared).toBe(false);
  });
});

describe('scopedDisplayValue', () => {
  const layered = {
    shared: { port: 4190 },
    local: { port: 4180 },
    resolved: { port: 4180 },
  };

  it('Shared mode shows the literal settings.json value EVEN when locally overridden (bug fix)', () => {
    // The rework's headline fix: a port overridden in the local layer used to
    // render blank under the Shared segment. It must show the shared value.
    const s = resolveFieldScope(layered, 'port');
    expect(scopedDisplayValue(s, 'shared')).toBe(4190);
  });

  it('Local mode shows the override when present', () => {
    const s = resolveFieldScope(layered, 'port');
    expect(scopedDisplayValue(s, 'local')).toBe(4180);
  });

  it('Local mode shows the inherited (resolved) value when not overridden', () => {
    const inheritedLayered = { shared: { appName: 'Team' }, local: {}, resolved: { appName: 'Team' } };
    const s = resolveFieldScope(inheritedLayered, 'appName');
    expect(s.overridden).toBe(false);
    expect(scopedDisplayValue(s, 'local')).toBe('Team');
  });

  it('Resolved mode shows the effective value', () => {
    const s = resolveFieldScope(layered, 'port');
    expect(scopedDisplayValue(s, 'resolved')).toBe(4180);
  });
});
