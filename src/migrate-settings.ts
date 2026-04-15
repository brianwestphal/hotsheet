import { getDb } from './db/connection.js';
import { readFileSettings, writeProjectSettings } from './file-settings.js';

/** Keys that belong to the plugin system and should stay in the DB. */
function isPluginKey(key: string): boolean {
  return key.startsWith('plugin:') || key.startsWith('plugin_enabled:');
}

/**
 * Migrate project settings from the DB settings table to settings.json.
 * - Only migrates non-plugin keys
 * - Never overrides values already in settings.json
 * - Deletes migrated keys from the DB after writing
 * - Safe to call multiple times (idempotent)
 */
export async function migrateDbSettingsToFile(dataDir: string): Promise<void> {
  const db = await getDb();
  const result = await db.query<{ key: string; value: string }>('SELECT key, value FROM settings');

  const projectRows = result.rows.filter(r => !isPluginKey(r.key));
  if (projectRows.length === 0) return;

  // Read existing file settings — never override values already there
  const existing = readFileSettings(dataDir);
  const toWrite: Record<string, string> = {};
  const migratedKeys: string[] = [];

  for (const row of projectRows) {
    if (!(row.key in existing)) {
      toWrite[row.key] = row.value;
    }
    migratedKeys.push(row.key);
  }

  // Write new values to settings.json (writeProjectSettings handles JSON parsing)
  if (Object.keys(toWrite).length > 0) {
    writeProjectSettings(dataDir, toWrite);
  }

  // Delete migrated keys from DB
  if (migratedKeys.length > 0) {
    await db.query(
      `DELETE FROM settings WHERE key = ANY($1::text[])`,
      [migratedKeys],
    );
    console.log(`[settings] Migrated ${migratedKeys.length} project setting(s) from database to settings.json`);
  }
}
