import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { ensureSecret, getBackupDir, readFileSettings, writeFileSettings } from './file-settings.js';

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
    const settings = readFileSettings(dir);
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
    expect(() => JSON.parse(raw)).not.toThrow();
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
