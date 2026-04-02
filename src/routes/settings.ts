import { Hono } from 'hono';

import {
  getAllTags,
  getCategories,
  getSettings,
  saveCategories,
  updateSetting,
} from '../db/queries.js';
import { scheduleAllSync } from '../sync/markdown.js';
import type { AppEnv, CategoryDef } from '../types.js';
import { CATEGORY_PRESETS } from '../types.js';
import { notifyChange } from './notify.js';

export const settingsRoutes = new Hono<AppEnv>();

// --- Tags ---

settingsRoutes.get('/tags', async (c) => {
  const tags = await getAllTags();
  return c.json(tags);
});

// --- Categories ---

settingsRoutes.get('/categories', async (c) => {
  const categories = await getCategories();
  return c.json(categories);
});

settingsRoutes.put('/categories', async (c) => {
  const categories = await c.req.json<CategoryDef[]>();
  await saveCategories(categories);
  scheduleAllSync(); notifyChange();
  return c.json(categories);
});

settingsRoutes.get('/category-presets', (c) => {
  return c.json(CATEGORY_PRESETS);
});

// --- Settings ---

settingsRoutes.get('/settings', async (c) => {
  const settings = await getSettings();
  return c.json(settings);
});

settingsRoutes.patch('/settings', async (c) => {
  const body = await c.req.json<Record<string, string>>();
  for (const [key, value] of Object.entries(body)) {
    await updateSetting(key, value);
  }
  return c.json({ ok: true });
});

// --- File-based settings (settings.json) ---

settingsRoutes.get('/file-settings', async (c) => {
  const { readFileSettings } = await import('../file-settings.js');
  const dataDir = c.get('dataDir');
  const settings = readFileSettings(dataDir);
  // Exclude sensitive fields before sending to client
  const safe: Partial<typeof settings> = { ...settings };
  delete safe.secret;
  delete safe.secretPathHash;
  delete safe.port;
  return c.json(safe);
});

settingsRoutes.patch('/file-settings', async (c) => {
  const { writeFileSettings } = await import('../file-settings.js');
  const dataDir = c.get('dataDir');
  const body = await c.req.json<Record<string, string>>();
  const updated = writeFileSettings(dataDir, body);
  return c.json(updated);
});
