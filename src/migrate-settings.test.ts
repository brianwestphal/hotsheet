import { readFileSync } from 'fs';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from './db/connection.js';
import { readFileSettings, writeFileSettings } from './file-settings.js';
import { migrateDbSettingsToFile } from './migrate-settings.js';
import { cleanupTestDb, setupTestDb } from './test-helpers.js';

let tempDir: string;

beforeAll(async () => {
  tempDir = await setupTestDb();
});

afterAll(async () => {
  await cleanupTestDb(tempDir);
});

/** Insert a row directly into the DB settings table. */
async function insertDbSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, value],
  );
}

/** Count rows remaining in the DB settings table matching the given key. */
async function countDbSetting(key: string): Promise<number> {
  const db = await getDb();
  const result = await db.query<{ count: string }>(`SELECT count(*) AS count FROM settings WHERE key = $1`, [key]);
  return parseInt(result.rows[0].count, 10);
}

/** Clear all rows from the DB settings table and reset settings.json. */
async function resetState(): Promise<void> {
  const db = await getDb();
  await db.query('DELETE FROM settings');
  // Write an empty settings.json
  writeFileSettings(tempDir, {});
  // Re-read to confirm it's clean — writeFileSettings merges, so overwrite directly
  const path = join(tempDir, 'settings.json');
  const { writeFileSync } = await import('fs');
  writeFileSync(path, '{}', 'utf-8');
}

beforeEach(async () => {
  await resetState();
});

describe('migrateDbSettingsToFile', () => {
  it('runs without error on a fresh DB (no settings to migrate)', async () => {
    await expect(migrateDbSettingsToFile(tempDir)).resolves.not.toThrow();
    // settings.json should remain empty
    const settings = readFileSettings(tempDir);
    expect(Object.keys(settings)).toHaveLength(0);
  });

  it('copies project settings from DB to settings.json', async () => {
    await insertDbSetting('detail_position', 'bottom');
    await insertDbSetting('sort_by', 'priority');

    await migrateDbSettingsToFile(tempDir);

    const settings = readFileSettings(tempDir);
    expect(settings.detail_position).toBe('bottom');
    expect(settings.sort_by).toBe('priority');
  });

  it('deletes migrated keys from the DB after migration', async () => {
    await insertDbSetting('detail_position', 'bottom');
    await insertDbSetting('sort_by', 'priority');

    await migrateDbSettingsToFile(tempDir);

    expect(await countDbSetting('detail_position')).toBe(0);
    expect(await countDbSetting('sort_by')).toBe(0);
  });

  it('does not migrate plugin keys (plugin: and plugin_enabled: prefixes)', async () => {
    await insertDbSetting('plugin:github:token', 'abc123');
    await insertDbSetting('plugin_enabled:github', 'true');
    await insertDbSetting('detail_position', 'right');

    await migrateDbSettingsToFile(tempDir);

    // Plugin keys should remain in DB
    expect(await countDbSetting('plugin:github:token')).toBe(1);
    expect(await countDbSetting('plugin_enabled:github')).toBe(1);

    // Project key should have been migrated and removed
    expect(await countDbSetting('detail_position')).toBe(0);

    // settings.json should only have the project key
    const settings = readFileSettings(tempDir);
    expect(settings.detail_position).toBe('right');
    expect(settings['plugin:github:token']).toBeUndefined();
    expect(settings['plugin_enabled:github']).toBeUndefined();
  });

  it('is idempotent — running twice does not duplicate or break', async () => {
    await insertDbSetting('detail_position', 'bottom');
    await insertDbSetting('sort_by', 'priority');

    await migrateDbSettingsToFile(tempDir);
    // Run again — DB keys were already deleted, so nothing to migrate
    await expect(migrateDbSettingsToFile(tempDir)).resolves.not.toThrow();

    const settings = readFileSettings(tempDir);
    expect(settings.detail_position).toBe('bottom');
    expect(settings.sort_by).toBe('priority');
  });

  it('does not overwrite values already present in settings.json', async () => {
    // Pre-populate settings.json with a value
    writeFileSettings(tempDir, { detail_position: 'right' });

    // Insert a conflicting value in DB
    await insertDbSetting('detail_position', 'bottom');
    await insertDbSetting('sort_by', 'priority');

    await migrateDbSettingsToFile(tempDir);

    const settings = readFileSettings(tempDir);
    // The existing file value should be preserved, not overwritten
    expect(settings.detail_position).toBe('right');
    // The new key should be written
    expect(settings.sort_by).toBe('priority');
  });

  it('does not overwrite reserved keys already in settings.json', async () => {
    // Pre-populate settings.json with reserved keys
    writeFileSettings(tempDir, { secret: 'my-secret', port: 4174 });

    // Insert settings in DB that match reserved key names
    await insertDbSetting('secret', 'db-secret');
    await insertDbSetting('port', '9999');

    await migrateDbSettingsToFile(tempDir);

    const settings = readFileSettings(tempDir);
    // Reserved keys in settings.json should be preserved
    expect(settings.secret).toBe('my-secret');
    expect(settings.port).toBe(4174);

    // The DB keys should still be deleted (they are non-plugin keys)
    expect(await countDbSetting('secret')).toBe(0);
    expect(await countDbSetting('port')).toBe(0);
  });

  it('handles JSON-valued settings correctly', async () => {
    const categories = JSON.stringify([{ id: 'epic', label: 'Epic' }]);
    await insertDbSetting('categories', categories);

    await migrateDbSettingsToFile(tempDir);

    // Read raw settings.json to verify JSON was stored as native JSON (via writeProjectSettings)
    const raw = JSON.parse(readFileSync(join(tempDir, 'settings.json'), 'utf-8')) as Record<string, unknown>;
    expect(raw.categories).toEqual([{ id: 'epic', label: 'Epic' }]);
  });

  it('migrates only when there are non-plugin rows', async () => {
    // Insert only plugin keys
    await insertDbSetting('plugin:test:key', 'value');

    await migrateDbSettingsToFile(tempDir);

    // settings.json should be untouched (still empty)
    const settings = readFileSettings(tempDir);
    expect(Object.keys(settings)).toHaveLength(0);

    // Plugin key should remain in DB
    expect(await countDbSetting('plugin:test:key')).toBe(1);
  });
});
