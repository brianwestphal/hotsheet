import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addNewTerminalsToNonDefaultGroupings, ensureSecret, getBackupDir, prunedHiddenTerminals, prunedVisibilityGroupings, readFileSettings, writeFileSettings } from './file-settings.js';

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
    // Verify it was persisted
    const settings = readFileSettings(dir);
    expect(settings.secret).toBe(secret);
    expect(settings.secretPathHash).toBeTruthy();
    expect(settings.port).toBe(4174);
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
    // Tamper with the path hash to simulate a directory move
    readFileSettings(dir);
    writeFileSettings(dir, { secretPathHash: 'wrong-hash' });
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
 * HS-7829 — `prunedHiddenTerminals` filters stale ids out of the persisted
 * `hidden_terminals` array whenever the configured `terminals[]` changes.
 * Pure helper, called from the `/file-settings` PATCH handler after a
 * terminals-list save.
 */
describe('prunedHiddenTerminals (HS-7829)', () => {
  it('returns null when nothing is hidden', () => {
    expect(prunedHiddenTerminals(undefined, new Set(['a', 'b']))).toBeNull();
    expect(prunedHiddenTerminals([], new Set(['a', 'b']))).toBeNull();
  });

  it('returns null when every hidden id is still present in the configured list', () => {
    expect(prunedHiddenTerminals(['a', 'b'], new Set(['a', 'b', 'c']))).toBeNull();
  });

  it('returns the pruned subset when one id no longer exists', () => {
    expect(prunedHiddenTerminals(['a', 'gone', 'b'], new Set(['a', 'b'])))
      .toEqual(['a', 'b']);
  });

  it('returns an empty array when every hidden id has been removed from the config', () => {
    expect(prunedHiddenTerminals(['gone1', 'gone2'], new Set(['a'])))
      .toEqual([]);
  });

  it('tolerates the legacy stringified-JSON shape (defense in depth)', () => {
    // Pre-HS-7825 callers occasionally stored JSON-valued keys as strings.
    // The helper should parse and apply the same prune.
    expect(prunedHiddenTerminals('["a", "gone"]', new Set(['a'])))
      .toEqual(['a']);
  });

  it('returns null when input is malformed (not array, not parseable JSON)', () => {
    expect(prunedHiddenTerminals('not-json', new Set(['a']))).toBeNull();
    expect(prunedHiddenTerminals(42, new Set(['a']))).toBeNull();
    expect(prunedHiddenTerminals({ id: 'a' }, new Set(['a']))).toBeNull();
  });

  it('returns the pruned list when configured ids set is empty (every hidden id gone)', () => {
    expect(prunedHiddenTerminals(['a', 'b'], new Set())).toEqual([]);
  });

  it('preserves order of remaining ids', () => {
    expect(prunedHiddenTerminals(['z', 'a', 'm', 'gone', 'k'], new Set(['z', 'a', 'm', 'k'])))
      .toEqual(['z', 'a', 'm', 'k']);
  });
});

/**
 * HS-7826 — `prunedVisibilityGroupings` is the parallel of
 * `prunedHiddenTerminals` for the new groupings shape. Walks every
 * grouping's `hiddenIds`, drops ids no longer in the configured set,
 * returns null when no prune is needed.
 */
describe('prunedVisibilityGroupings (HS-7826)', () => {
  it('returns null when no grouping has stale ids', () => {
    const groupings = [
      { id: 'default', name: 'Default', hiddenIds: ['t1'] },
      { id: 'g-1', name: 'Logs', hiddenIds: ['t1', 't2'] },
    ];
    expect(prunedVisibilityGroupings(groupings, new Set(['t1', 't2']))).toBeNull();
  });

  it('strips stale ids from every grouping and preserves grouping order + names', () => {
    const groupings = [
      { id: 'default', name: 'Default', hiddenIds: ['t1', 'gone'] },
      { id: 'g-1', name: 'Logs', hiddenIds: ['gone', 't2'] },
    ];
    const next = prunedVisibilityGroupings(groupings, new Set(['t1', 't2']));
    expect(next).toEqual([
      { id: 'default', name: 'Default', hiddenIds: ['t1'] },
      { id: 'g-1', name: 'Logs', hiddenIds: ['t2'] },
    ]);
  });

  it('tolerates the stringified-JSON shape', () => {
    const raw = JSON.stringify([{ id: 'default', name: 'Default', hiddenIds: ['gone', 't1'] }]);
    const next = prunedVisibilityGroupings(raw, new Set(['t1']));
    expect(next).toEqual([{ id: 'default', name: 'Default', hiddenIds: ['t1'] }]);
  });

  it('drops malformed grouping entries (missing id, wrong type)', () => {
    const raw = [
      { id: 'a', name: 'A', hiddenIds: ['t1', 'gone'] },
      { name: 'no-id', hiddenIds: [] },
      'string-not-object',
    ];
    const next = prunedVisibilityGroupings(raw, new Set(['t1']));
    expect(next).toEqual([{ id: 'a', name: 'A', hiddenIds: ['t1'] }]);
  });

  it('returns null when input is malformed', () => {
    expect(prunedVisibilityGroupings('not-json', new Set(['t1']))).toBeNull();
    expect(prunedVisibilityGroupings(42, new Set(['t1']))).toBeNull();
  });

  it('returns an empty hiddenIds array per grouping when configured set is empty', () => {
    const groupings = [{ id: 'a', name: 'A', hiddenIds: ['t1', 't2'] }];
    expect(prunedVisibilityGroupings(groupings, new Set())).toEqual([
      { id: 'a', name: 'A', hiddenIds: [] },
    ]);
  });
});

/**
 * HS-7949 — `addNewTerminalsToNonDefaultGroupings` is the post-prune step
 * that ensures a freshly-added terminal id starts hidden in every
 * non-Default grouping. Default keeps showing it. Pure helper, no I/O.
 */
describe('addNewTerminalsToNonDefaultGroupings (HS-7949)', () => {
  it('returns null when no new ids', () => {
    const groupings = [
      { id: 'default', name: 'Default', hiddenIds: [] },
      { id: 'g-1', name: 'Logs', hiddenIds: ['t1'] },
    ];
    expect(addNewTerminalsToNonDefaultGroupings(groupings, [])).toBeNull();
  });

  it('appends each new id to every non-Default grouping; Default stays untouched', () => {
    const groupings = [
      { id: 'default', name: 'Default', hiddenIds: [] },
      { id: 'g-logs', name: 'Logs', hiddenIds: ['t1'] },
      { id: 'g-claude', name: 'Claude', hiddenIds: [] },
    ];
    const next = addNewTerminalsToNonDefaultGroupings(groupings, ['new-1', 'new-2']);
    expect(next).toEqual([
      { id: 'default', name: 'Default', hiddenIds: [] },
      { id: 'g-logs', name: 'Logs', hiddenIds: ['t1', 'new-1', 'new-2'] },
      { id: 'g-claude', name: 'Claude', hiddenIds: ['new-1', 'new-2'] },
    ]);
  });

  it('skips an id already hidden in a non-Default grouping (idempotent)', () => {
    const groupings = [
      { id: 'default', name: 'Default', hiddenIds: [] },
      { id: 'g-1', name: 'Logs', hiddenIds: ['t1'] },
    ];
    expect(addNewTerminalsToNonDefaultGroupings(groupings, ['t1'])).toBeNull();
  });

  it('partial-already-hidden case still appends only the genuinely-new id', () => {
    const groupings = [
      { id: 'default', name: 'Default', hiddenIds: [] },
      { id: 'g-1', name: 'Logs', hiddenIds: ['t1'] },
    ];
    expect(addNewTerminalsToNonDefaultGroupings(groupings, ['t1', 't2'])).toEqual([
      { id: 'default', name: 'Default', hiddenIds: [] },
      { id: 'g-1', name: 'Logs', hiddenIds: ['t1', 't2'] },
    ]);
  });

  it('returns null when there are no non-Default groupings to hide in', () => {
    const groupings = [{ id: 'default', name: 'Default', hiddenIds: [] }];
    expect(addNewTerminalsToNonDefaultGroupings(groupings, ['new'])).toBeNull();
  });

  it('tolerates the stringified-JSON shape', () => {
    const raw = JSON.stringify([
      { id: 'default', name: 'Default', hiddenIds: [] },
      { id: 'g-1', name: 'Logs', hiddenIds: [] },
    ]);
    expect(addNewTerminalsToNonDefaultGroupings(raw, ['new'])).toEqual([
      { id: 'default', name: 'Default', hiddenIds: [] },
      { id: 'g-1', name: 'Logs', hiddenIds: ['new'] },
    ]);
  });

  it('drops malformed grouping entries (missing id, wrong type)', () => {
    const raw = [
      { id: 'g-keep', name: 'Keep', hiddenIds: [] },
      { name: 'no-id', hiddenIds: [] },
      'string-not-object',
    ];
    expect(addNewTerminalsToNonDefaultGroupings(raw, ['new'])).toEqual([
      { id: 'g-keep', name: 'Keep', hiddenIds: ['new'] },
    ]);
  });

  it('returns null when input is malformed', () => {
    expect(addNewTerminalsToNonDefaultGroupings('not-json', ['new'])).toBeNull();
    expect(addNewTerminalsToNonDefaultGroupings(42, ['new'])).toBeNull();
    expect(addNewTerminalsToNonDefaultGroupings(null, ['new'])).toBeNull();
  });

  it('preserves existing hiddenIds order (additions appended at the end)', () => {
    const groupings = [
      { id: 'default', name: 'Default', hiddenIds: [] },
      { id: 'g-1', name: 'Logs', hiddenIds: ['existing-a', 'existing-b'] },
    ];
    const next = addNewTerminalsToNonDefaultGroupings(groupings, ['new-1']);
    expect(next).toEqual([
      { id: 'default', name: 'Default', hiddenIds: [] },
      { id: 'g-1', name: 'Logs', hiddenIds: ['existing-a', 'existing-b', 'new-1'] },
    ]);
  });
});
