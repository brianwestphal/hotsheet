import { readProjectSettings, writeProjectSettings } from '../file-settings.js';
import type { CategoryDef } from '../types.js';
import { DEFAULT_CATEGORIES } from '../types.js';
import { getDataDir, getDb } from './connection.js';

/** Keys that belong to the plugin system and stay in the DB. */
function isPluginKey(key: string): boolean {
  return key.startsWith('plugin:') || key.startsWith('plugin_enabled:');
}

// --- Settings ---

/** Read all settings — merges file-based project settings with DB plugin settings. */
export async function getSettings(): Promise<Record<string, string>> {
  const dataDir = getDataDir();
  const projectSettings = readProjectSettings(dataDir);

  // Read plugin settings from DB
  const db = await getDb();
  const result = await db.query<{ key: string; value: string }>('SELECT key, value FROM settings');
  const merged: Record<string, string> = { ...projectSettings };
  for (const row of result.rows) {
    merged[row.key] = row.value;
  }
  return merged;
}

/** Write a single setting — routes to file (project settings) or DB (plugin settings). */
export async function updateSetting(key: string, value: string): Promise<void> {
  if (isPluginKey(key)) {
    const db = await getDb();
    await db.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, value],
    );
  } else {
    const dataDir = getDataDir();
    writeProjectSettings(dataDir, { [key]: value });
  }
}

// --- Categories ---

export async function getCategories(): Promise<CategoryDef[]> {
  const settings = await getSettings();
  if (settings.categories) {
    try {
      const parsed: unknown = JSON.parse(settings.categories);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as CategoryDef[];
    } catch { /* invalid JSON, use defaults */ }
  }
  return DEFAULT_CATEGORIES;
}

export async function saveCategories(categories: CategoryDef[]): Promise<void> {
  await updateSetting('categories', JSON.stringify(categories));
}
