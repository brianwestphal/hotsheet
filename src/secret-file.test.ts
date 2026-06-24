import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureSecret, readFileSettings } from './file-settings.js';
import { getProjectSecret, readSecretFile, secretFilePath, writeSecretFile } from './secret-file.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hs-secret-')); });
afterEach(() => { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

const settingsPath = (d: string) => join(d, 'settings.json');

describe('readSecretFile / writeSecretFile', () => {
  it('round-trips', () => {
    writeSecretFile(dir, { secret: 'abc', secretPathHash: 'h' });
    expect(readSecretFile(dir)).toEqual({ secret: 'abc', secretPathHash: 'h' });
  });
  it('returns {} when absent or malformed', () => {
    expect(readSecretFile(dir)).toEqual({});
    writeFileSync(secretFilePath(dir), 'not json');
    expect(readSecretFile(dir)).toEqual({});
  });
});

describe('getProjectSecret', () => {
  it('prefers the sidecar', () => {
    writeSecretFile(dir, { secret: 'sidecar-secret' });
    writeFileSync(settingsPath(dir), JSON.stringify({ secret: 'legacy-secret' }));
    expect(getProjectSecret(dir)).toBe('sidecar-secret');
  });
  it('falls back to the legacy settings.json secret (un-migrated)', () => {
    writeFileSync(settingsPath(dir), JSON.stringify({ secret: 'legacy-secret', port: 4174 }));
    expect(getProjectSecret(dir)).toBe('legacy-secret');
  });
  it('returns "" when neither has a secret', () => {
    expect(getProjectSecret(dir)).toBe('');
    writeFileSync(settingsPath(dir), JSON.stringify({ port: 4174 }));
    expect(getProjectSecret(dir)).toBe('');
  });
});

describe('ensureSecret migration (HS-8999)', () => {
  it('mints into secret.json and leaves settings.json secret-free on a fresh project', () => {
    const secret = ensureSecret(dir, 4174);
    expect(secret).toMatch(/^[0-9a-f]{32}$/);
    expect(readSecretFile(dir).secret).toBe(secret);   // in the sidecar
    const settings = readFileSettings(dir);
    expect(settings.secret).toBeUndefined();            // NOT in settings.json
    expect(settings.port).toBe(4174);                   // port stays
  });

  it('migrates a legacy settings.json secret, PRESERVING the value, and strips it', () => {
    // A pre-HS-8999 settings.json with the secret inline + a matching path hash.
    // First mint to learn the path hash, then simulate the legacy layout.
    const minted = ensureSecret(dir, 4174);
    const hash = readSecretFile(dir).secretPathHash;
    // Re-create the legacy state: secret inline in settings.json, no sidecar.
    rmSync(secretFilePath(dir));
    writeFileSync(settingsPath(dir), JSON.stringify({ secret: minted, secretPathHash: hash, port: 4174, appName: 'X' }));

    const got = ensureSecret(dir, 4174);
    expect(got).toBe(minted);                           // value preserved
    expect(readSecretFile(dir).secret).toBe(minted);    // moved to sidecar
    const settings = readFileSettings(dir);
    expect(settings.secret).toBeUndefined();            // stripped from settings.json
    expect(settings.secretPathHash).toBeUndefined();
    expect(settings.appName).toBe('X');                 // other config untouched
  });

  it('reuses an existing valid sidecar secret without rewriting it', () => {
    const first = ensureSecret(dir, 4174);
    const second = ensureSecret(dir, 4174);
    expect(second).toBe(first);
  });

  it('does not write the secret into settings.json on disk', () => {
    ensureSecret(dir, 4174);
    const rawSettings = readFileSync(settingsPath(dir), 'utf-8');
    expect(rawSettings).not.toContain('secret');
  });
});
