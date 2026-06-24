import { describe, expect, it } from 'vitest';

import {
  buildSharingRows,
  type SettingRegistryEntry,
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

describe('buildSharingRows', () => {
  const registry: SettingRegistryEntry[] = [
    { key: 'appName', label: 'App name', defaultLayer: 'shared', kind: 'text' },
    { key: 'backupDir', label: 'Backup directory', defaultLayer: 'local', kind: 'text' },
    { key: 'port', label: 'Server port', defaultLayer: 'local', kind: 'number' },
  ];

  it('computes origin/overridden from layer presence (local wins)', () => {
    const rows = buildSharingRows({
      shared: { appName: 'Team', backupDir: '/team/default' },
      local: { backupDir: '/me/local', port: 4180 },
      resolved: { appName: 'Team', backupDir: '/me/local', port: 4180 },
    }, registry);

    const byKey = Object.fromEntries(rows.map(r => [r.key, r]));
    // appName: only shared.
    expect(byKey.appName.origin).toBe('shared');
    expect(byKey.appName.overridden).toBe(false);
    // backupDir: in both → overridden, origin local.
    expect(byKey.backupDir.origin).toBe('local');
    expect(byKey.backupDir.overridden).toBe(true);
    expect(byKey.backupDir.resolvedDisplay).toBe('/me/local');
    expect(byKey.backupDir.sharedDisplay).toBe('/team/default');
    // port: only local.
    expect(byKey.port.origin).toBe('local');
    expect(byKey.port.overridden).toBe(true);
  });

  it('marks a key absent from both layers as default origin', () => {
    const rows = buildSharingRows({ shared: {}, local: {}, resolved: {} }, registry);
    expect(rows.find(r => r.key === 'backupDir')?.origin).toBe('default');
    expect(rows.find(r => r.key === 'port')?.overridden).toBe(false);
  });

  it('always includes every registry key, even when unset', () => {
    const rows = buildSharingRows({ shared: {}, local: {}, resolved: {} }, registry);
    expect(rows.map(r => r.key)).toEqual(['appName', 'backupDir', 'port']);
  });

  it('surfaces present-but-unregistered keys as read-only "other" rows, sorted', () => {
    const rows = buildSharingRows({
      shared: { zeta_key: 'z', alpha_key: 'a' },
      local: { mystery: 'm' },
      resolved: { zeta_key: 'z', alpha_key: 'a', mystery: 'm' },
    }, registry);
    const others = rows.filter(r => r.isOther);
    expect(others.map(r => r.key)).toEqual(['alpha_key', 'mystery', 'zeta_key']); // sorted
    expect(others.every(r => r.kind === 'complex')).toBe(true);
    // An other key only in local is tagged local origin.
    expect(others.find(r => r.key === 'mystery')?.origin).toBe('local');
  });
});
