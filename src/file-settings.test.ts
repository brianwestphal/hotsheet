import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureSecret, getBackupDir, readFileSettings, resolveAuthoritativeDataDir, writeFileSettings } from './file-settings.js';
import { readSecretFile, writeSecretFile } from './secret-file.js';

let tempDir: string;

beforeAll(() => {
  tempDir = join(tmpdir(), `hs-settings-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('readFileSettings', () => {
  it('returns empty object if file missing', () => {
    expect(readFileSettings(join(tempDir, 'nonexistent'))).toEqual({});
  });

  it('returns parsed settings', () => {
    const dir = join(tempDir, 'valid');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ appName: 'Test' }));
    const result = readFileSettings(dir);
    expect(result.appName).toBe('Test');
  });

  it('returns empty object for corrupt file', () => {
    const dir = join(tempDir, 'corrupt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), 'not valid json');
    expect(readFileSettings(dir)).toEqual({});
  });
});

describe('writeFileSettings', () => {
  it('creates settings file', () => {
    const dir = join(tempDir, 'create');
    mkdirSync(dir, { recursive: true });
    const result = writeFileSettings(dir, { appName: 'New' });
    expect(result.appName).toBe('New');
  });

  it('merges into existing settings', () => {
    const dir = join(tempDir, 'merge');
    mkdirSync(dir, { recursive: true });
    writeFileSettings(dir, { appName: 'First' });
    const result = writeFileSettings(dir, { backupDir: '/custom' });
    expect(result.appName).toBe('First');
    expect(result.backupDir).toBe('/custom');
  });
});

describe('getBackupDir', () => {
  it('returns default if not configured', () => {
    const dir = join(tempDir, 'default-backup');
    mkdirSync(dir, { recursive: true });
    expect(getBackupDir(dir)).toBe(join(dir, 'backups'));
  });

  it('returns custom dir if configured', () => {
    const dir = join(tempDir, 'custom-backup');
    mkdirSync(dir, { recursive: true });
    writeFileSettings(dir, { backupDir: '/custom/backups' });
    expect(getBackupDir(dir)).toBe('/custom/backups');
  });
});

describe('ensureSecret', () => {
  it('generates a new secret when none exists', () => {
    const dir = join(tempDir, 'secret-new');
    mkdirSync(dir, { recursive: true });
    const secret = ensureSecret(dir, 4174);
    expect(secret).toBeTruthy();
    expect(secret).toHaveLength(32);
    // HS-8999 — persisted to the secret.json sidecar, NOT settings.json.
    const sidecar = readSecretFile(dir);
    expect(sidecar.secret).toBe(secret);
    expect(sidecar.secretPathHash).toBeTruthy();
    const settings = readFileSettings(dir);
    expect(settings.secret).toBeUndefined();
    expect(settings.port).toBe(4174); // port stays in settings.json
  });

  it('returns existing secret when path hash matches', () => {
    const dir = join(tempDir, 'secret-existing');
    mkdirSync(dir, { recursive: true });
    const secret1 = ensureSecret(dir, 4174);
    const secret2 = ensureSecret(dir, 4174);
    expect(secret2).toBe(secret1);
  });

  it('updates port without regenerating secret', () => {
    const dir = join(tempDir, 'secret-port');
    mkdirSync(dir, { recursive: true });
    const secret1 = ensureSecret(dir, 4174);
    const secret2 = ensureSecret(dir, 4175);
    expect(secret2).toBe(secret1);
    // Verify port was updated
    const settings = readFileSettings(dir);
    expect(settings.port).toBe(4175);
  });

  it('regenerates secret when path hash changes', () => {
    const dir = join(tempDir, 'secret-rehash');
    mkdirSync(dir, { recursive: true });
    const secret1 = ensureSecret(dir, 4174);
    // HS-8999 — the path hash lives in the sidecar now; tamper it to simulate a
    // directory move so ensureSecret regenerates.
    writeSecretFile(dir, { secret: secret1, secretPathHash: 'wrong-hash' });
    const secret2 = ensureSecret(dir, 4174);
    expect(secret2).not.toBe(secret1);
    expect(secret2).toHaveLength(32);
  });

  it('regenerates secret when secretPathHash is missing', () => {
    const dir = join(tempDir, 'secret-nohash');
    mkdirSync(dir, { recursive: true });
    // Write a secret without a path hash (simulating old data)
    writeFileSettings(dir, { secret: 'old-secret-value' });
    const secret = ensureSecret(dir, 4174);
    expect(secret).not.toBe('old-secret-value');
    expect(secret).toHaveLength(32);
  });

  it('generates unique secrets for different directories', () => {
    const dir1 = join(tempDir, 'secret-unique-1');
    const dir2 = join(tempDir, 'secret-unique-2');
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    const secret1 = ensureSecret(dir1, 4174);
    const secret2 = ensureSecret(dir2, 4174);
    expect(secret1).not.toBe(secret2);
  });
});

describe('writeFileSettings edge cases', () => {
  it('overwrites existing keys with new values', () => {
    const dir = join(tempDir, 'overwrite');
    mkdirSync(dir, { recursive: true });
    writeFileSettings(dir, { appName: 'First' });
    writeFileSettings(dir, { appName: 'Second' });
    const settings = readFileSettings(dir);
    expect(settings.appName).toBe('Second');
  });

  it('writes valid JSON with trailing newline', () => {
    const dir = join(tempDir, 'json-format');
    mkdirSync(dir, { recursive: true });
    writeFileSettings(dir, { appName: 'Test' });
    const raw = readFileSync(join(dir, 'settings.json'), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(raw) as unknown).not.toThrow();
  });

  it('handles writing to non-existent file (create from scratch)', () => {
    const dir = join(tempDir, 'fresh-write');
    mkdirSync(dir, { recursive: true });
    const result = writeFileSettings(dir, { port: 4174, appIcon: 'red' });
    expect(result.port).toBe(4174);
    expect(result.appIcon).toBe('red');
  });

  it('preserves all existing keys when adding new ones', () => {
    const dir = join(tempDir, 'preserve-all');
    mkdirSync(dir, { recursive: true });
    writeFileSettings(dir, { appName: 'App', backupDir: '/backup', port: 4174 });
    writeFileSettings(dir, { appIcon: 'blue' });
    const settings = readFileSettings(dir);
    expect(settings.appName).toBe('App');
    expect(settings.backupDir).toBe('/backup');
    expect(settings.port).toBe(4174);
    expect(settings.appIcon).toBe('blue');
  });
});

/**
 * HS-8290 — six dashboard-related keys (visibility_groupings,
 * active_visibility_grouping_id, hidden_terminals, dashboard_layout_mode,
 * dashboard_columns_per_row, dashboard_slider_value) moved to global
 * config (~/.hotsheet/config.json under `dashboard`). The reader strips
 * them from the in-memory shape so old per-project settings.json files
 * stop surfacing stale values; the next writeFileSettings then drops
 * them from disk via the read-merge-write flow.
 */
describe('HS-8290 — dashboard keys stripped on read + dropped on next write', () => {
  const dataDir = join(tmpdir(), `hs-fs-8290-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dataDir, { recursive: true });

  it('readFileSettings drops every HS-8290 dead key from the in-memory shape', () => {
    const settingsPath = join(dataDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      appName: 'keepme',
      visibility_groupings: [{ id: 'default', name: 'D', hiddenIds: ['x'] }],
      active_visibility_grouping_id: 'default',
      hidden_terminals: ['x'],
      dashboard_layout_mode: 'flat',
      dashboard_columns_per_row: 5,
      dashboard_slider_value: 33,
    }));
    const out = readFileSettings(dataDir);
    expect(out.appName).toBe('keepme');
    expect(out.visibility_groupings).toBeUndefined();
    expect(out.active_visibility_grouping_id).toBeUndefined();
    expect(out.hidden_terminals).toBeUndefined();
    expect(out.dashboard_layout_mode).toBeUndefined();
    expect(out.dashboard_columns_per_row).toBeUndefined();
    expect(out.dashboard_slider_value).toBeUndefined();
  });

  it('next writeFileSettings persists the cleaned shape to disk', () => {
    const settingsPath = join(dataDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      appName: 'keepme',
      visibility_groupings: [{ id: 'default', name: 'D', hiddenIds: [] }],
      hidden_terminals: ['stale'],
    }));
    writeFileSettings(dataDir, { appName: 'updated' });
    const onDisk = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    expect(onDisk.appName).toBe('updated');
    expect(onDisk.visibility_groupings).toBeUndefined();
    expect(onDisk.hidden_terminals).toBeUndefined();
  });
});

describe('resolveAuthoritativeDataDir (HS-8934 — git-worktree follower)', () => {
  function makeDir(name: string, settings?: Record<string, unknown>): string {
    const dir = join(tempDir, 'wt', name);
    mkdirSync(dir, { recursive: true });
    if (settings) writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
    return dir;
  }

  it('returns the (resolved) input dir when there is no pointer', () => {
    const owner = makeDir('owner-noptr', { appName: 'Owner' });
    expect(resolveAuthoritativeDataDir(owner)).toBe(owner);
  });

  it('returns the input dir when settings.json is absent', () => {
    const dir = makeDir('no-settings');
    expect(resolveAuthoritativeDataDir(dir)).toBe(dir);
  });

  it('redirects a follower to its authoritative owner', () => {
    const owner = makeDir('owner-a', { appName: 'Owner A' });
    const follower = makeDir('follower-a', { authoritativeDataDir: owner });
    expect(resolveAuthoritativeDataDir(follower)).toBe(owner);
  });

  it('treats an empty/whitespace pointer as no pointer', () => {
    const dir = makeDir('blank-ptr', { authoritativeDataDir: '   ' });
    expect(resolveAuthoritativeDataDir(dir)).toBe(dir);
  });

  it('throws on a self-referential pointer', () => {
    const dir = makeDir('self-ptr');
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ authoritativeDataDir: dir }));
    expect(() => resolveAuthoritativeDataDir(dir)).toThrow(/points at itself/);
  });

  it('throws when the target does not exist', () => {
    const follower = makeDir('follower-missing', { authoritativeDataDir: join(tempDir, 'wt', 'does-not-exist') });
    expect(() => resolveAuthoritativeDataDir(follower)).toThrow(/does not exist/);
  });

  it('throws on a chained follower (target is itself a follower)', () => {
    const owner = makeDir('owner-chain', { appName: 'Owner' });
    const mid = makeDir('mid-chain', { authoritativeDataDir: owner });
    const follower = makeDir('follower-chain', { authoritativeDataDir: mid });
    expect(() => resolveAuthoritativeDataDir(follower)).toThrow(/chains not allowed/);
  });
});
