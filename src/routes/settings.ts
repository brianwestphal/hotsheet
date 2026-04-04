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
import { parseBody, UpdateSettingsSchema, UpdateCategoriesSchema } from './validation.js';

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
  const raw = await c.req.json();
  const parsed = parseBody(UpdateCategoriesSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const categories = parsed.data;
  await saveCategories(categories);
  scheduleAllSync(c.get('dataDir')); notifyChange();
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
  const raw = await c.req.json();
  const parsed = parseBody(UpdateSettingsSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  for (const [key, value] of Object.entries(parsed.data)) {
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
  const { getProjectByDataDir } = await import('../projects.js');
  const dataDir = c.get('dataDir');
  const raw = await c.req.json();
  const parsed = parseBody(UpdateSettingsSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const updated = writeFileSettings(dataDir, parsed.data);
  // Update project tab name when appName changes
  if ('appName' in parsed.data) {
    const project = getProjectByDataDir(dataDir);
    if (project) {
      const dirName = dataDir.replace(/\/.hotsheet\/?$/, '').split('/').pop() ?? dataDir;
      project.name = (parsed.data.appName !== undefined && parsed.data.appName !== '') ? parsed.data.appName : dirName;
      notifyChange(); // Refresh tabs with new name
    }
  }
  return c.json(updated);
});
