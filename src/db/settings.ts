import type { CategoryDef } from '../types.js';
import { DEFAULT_CATEGORIES } from '../types.js';
import { getDb } from './connection.js';

// --- Settings ---

export async function getSettings(): Promise<Record<string, string>> {
  const db = await getDb();
  const result = await db.query<{ key: string; value: string }>('SELECT key, value FROM settings');
  const settings: Record<string, string> = {};
  for (const row of result.rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

export async function updateSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, value]
  );
}

// --- Categories ---

export async function getCategories(): Promise<CategoryDef[]> {
  const settings = await getSettings();
  if (settings.categories) {
    try {
      const parsed = JSON.parse(settings.categories);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch { /* invalid JSON, use defaults */ }
  }
  return DEFAULT_CATEGORIES;
}

export async function saveCategories(categories: CategoryDef[]): Promise<void> {
  await updateSetting('categories', JSON.stringify(categories));
}
