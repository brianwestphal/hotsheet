import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { getBackupDir, readFileSettings, writeFileSettings } from './file-settings.js';

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
