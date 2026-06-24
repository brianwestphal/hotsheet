import { type Context, Hono } from 'hono';

import {
  getAllTags,
  getCategories,
  getSettings,
  saveCategories,
  updateSetting,
} from '../db/queries.js';
import {
  clearLocalOverrides,
  type FileSettings,
  readFileSettings,
  readLocalSettings,
  readSharedSettings,
  writeFileSettings,
  writeSettingsLayer,
} from '../file-settings.js';
import { getProjectByDataDir } from '../projects.js';
import { scheduleAllSync } from '../sync/markdown.js';
import { eagerSpawnTerminals } from '../terminals/eagerSpawn.js';
import type { AppEnv } from '../types.js';
import { CATEGORY_PRESETS } from '../types.js';
import { notifyChange, notifyMutation } from './notify.js';
import { emitSync } from './syncEmit.js';
import {
  ClearLocalSettingsSchema,
  parseBody,
  UpdateCategoriesSchema,
  UpdateFileSettingsLayerSchema,
  UpdateFileSettingsSchema,
  UpdateSettingsSchema,
} from './validation.js';

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
  const raw: unknown = await c.req.json();
  const parsed = parseBody(UpdateCategoriesSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const categories = parsed.data;
  await saveCategories(categories);
  notifyMutation(c.get('dataDir'));
  emitSync(c, { type: 'settings-changed', key: 'categories', value: categories });
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
  const raw: unknown = await c.req.json();
  const parsed = parseBody(UpdateSettingsSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  for (const [key, value] of Object.entries(parsed.data)) {
    await updateSetting(key, value);
    emitSync(c, { type: 'settings-changed', key, value });
  }
  notifyChange();
  return c.json({ ok: true });
});

// --- File-based settings (settings.json) ---

settingsRoutes.get('/file-settings', (c) => {
  const dataDir = c.get('dataDir');
  const settings = readFileSettings(dataDir);
  // Exclude sensitive fields before sending to client
  const safe: Partial<typeof settings> = { ...settings };
  delete safe.secret;
  delete safe.secretPathHash;
  delete safe.port;
  return c.json(safe);
});

/**
 * Side-effects shared by every file-settings write path (the plain PATCH +
 * HS-9004's layered PATCH / clear-local). `changed` is the object of keys that
 * were written; their effective values are read from the (already-written)
 * resolved settings so the layer doesn't matter.
 */
function applyFileSettingsSideEffects(
  c: Context<AppEnv>,
  dataDir: string,
  secret: string,
  changed: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(changed)) {
    emitSync(c, { type: 'settings-changed', key, value });
  }
  // Update project tab name when appName changes (read the resolved value).
  if ('appName' in changed) {
    const project = getProjectByDataDir(dataDir);
    const newAppName = readFileSettings(dataDir).appName;
    if (project && typeof newAppName === 'string') {
      const dirName = dataDir.replace(/\/.hotsheet\/?$/, '').split('/').pop() ?? dataDir;
      project.name = newAppName !== '' ? newAppName : dirName;
      notifyChange(); // Refresh tabs with new name
    }
  }
  // HS-8917 — the worklist preamble is rendered into worklist.md, so a change
  // must regenerate it.
  if ('worklist_preamble' in changed) {
    scheduleAllSync(dataDir);
  }
  // When the terminals list changes, eager-spawn any non-lazy entries not yet
  // running (HS-6310). Fires after the write so the new config is read by
  // listTerminalConfigs.
  if ('terminals' in changed) {
    eagerSpawnTerminals(secret, dataDir);
  }
}

settingsRoutes.patch('/file-settings', async (c) => {
  const dataDir = c.get('dataDir');
  const secret = c.get('projectSecret');
  const raw: unknown = await c.req.json();
  const parsed = parseBody(UpdateFileSettingsSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const updated = writeFileSettings(dataDir, parsed.data);
  // HS-7992 added a `hotsheet_skill_clear_context` toggle that triggered a
  // skill-body regen on flip; HS-8022 removed the toggle entirely (the
  // `/clear` prefix was a no-op). The SKILL_VERSION bump on the same commit
  // means existing files re-author themselves through the normal upgrade
  // path on next boot, so no on-PATCH regen hook is needed any more.
  applyFileSettingsSideEffects(c, dataDir, secret, parsed.data);
  return c.json(updated);
});

// --- HS-9004 — layered (shared/local) file-settings (Settings → Sharing tab) ---

/** Strip the secret keys before any layered settings leave the server. */
function stripSensitive(s: FileSettings): Record<string, unknown> {
  const { secret: _s, secretPathHash: _h, ...rest } = s;
  void _s; void _h;
  return rest;
}

/** The three views the Sharing tab renders. */
function layeredPayload(dataDir: string): { shared: Record<string, unknown>; local: Record<string, unknown>; resolved: Record<string, unknown> } {
  return {
    shared: stripSensitive(readSharedSettings(dataDir)),
    local: stripSensitive(readLocalSettings(dataDir)),
    resolved: stripSensitive(readFileSettings(dataDir)),
  };
}

settingsRoutes.get('/file-settings/layered', (c) => {
  return c.json(layeredPayload(c.get('dataDir')));
});

settingsRoutes.patch('/file-settings/layer', async (c) => {
  const dataDir = c.get('dataDir');
  const secret = c.get('projectSecret');
  const raw: unknown = await c.req.json();
  const parsed = parseBody(UpdateFileSettingsLayerSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  writeSettingsLayer(dataDir, parsed.data.layer, parsed.data.settings);
  applyFileSettingsSideEffects(c, dataDir, secret, parsed.data.settings);
  return c.json(layeredPayload(dataDir));
});

settingsRoutes.post('/file-settings/clear-local', async (c) => {
  const dataDir = c.get('dataDir');
  const secret = c.get('projectSecret');
  const raw: unknown = await c.req.json();
  const parsed = parseBody(ClearLocalSettingsSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  clearLocalOverrides(dataDir, parsed.data.keys);
  // Resolved values for the cleared keys changed — re-fire their side-effects.
  applyFileSettingsSideEffects(c, dataDir, secret, Object.fromEntries(parsed.data.keys.map(k => [k, readFileSettings(dataDir)[k]])));
  return c.json(layeredPayload(dataDir));
});
