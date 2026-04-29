import { Hono } from 'hono';

import {
  getAllTags,
  getCategories,
  getSettings,
  saveCategories,
  updateSetting,
} from '../db/queries.js';
import type { AppEnv } from '../types.js';
import { CATEGORY_PRESETS } from '../types.js';
import { notifyChange, notifyMutation } from './notify.js';
import { parseBody, UpdateCategoriesSchema, UpdateFileSettingsSchema,UpdateSettingsSchema } from './validation.js';

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
  }
  notifyChange();
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
  const secret = c.get('projectSecret');
  const raw: unknown = await c.req.json();
  const parsed = parseBody(UpdateFileSettingsSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  // HS-7949 — capture the configured-terminal id set BEFORE the write so the
  // post-write follow-up step can diff (newIds = afterWrite - beforeWrite)
  // and apply the new-terminals-hidden-in-non-Default-groupings rule.
  // Captured unconditionally (cheap) rather than gated on `'terminals' in
  // parsed.data` to keep the control flow flat.
  const { listTerminalConfigs: listTerminalConfigsForDiff } = await import('../terminals/config.js');
  const previousConfiguredIds = new Set(listTerminalConfigsForDiff(dataDir).map(t => t.id));
  const updated = writeFileSettings(dataDir, parsed.data);
  // HS-7992 added a `hotsheet_skill_clear_context` toggle that triggered a
  // skill-body regen on flip; HS-8022 removed the toggle entirely (the
  // `/clear` prefix was a no-op). The SKILL_VERSION bump on the same commit
  // means existing files re-author themselves through the normal upgrade
  // path on next boot, so no on-PATCH regen hook is needed any more.
  // Update project tab name when appName changes
  if ('appName' in parsed.data) {
    const project = getProjectByDataDir(dataDir);
    const newAppName = parsed.data.appName;
    if (project && typeof newAppName === 'string') {
      const dirName = dataDir.replace(/\/.hotsheet\/?$/, '').split('/').pop() ?? dataDir;
      project.name = newAppName !== '' ? newAppName : dirName;
      notifyChange(); // Refresh tabs with new name
    }
  }
  // When the terminals list changes, eager-spawn any non-lazy entries that are
  // not yet running (HS-6310). Fires after the write so the new config is read
  // by listTerminalConfigs.
  if ('terminals' in parsed.data) {
    const { eagerSpawnTerminals } = await import('../terminals/eagerSpawn.js');
    eagerSpawnTerminals(secret, dataDir);
    // HS-7829 / HS-7826 — prune any persisted hidden ids (legacy
    // `hidden_terminals` flat list AND modern `visibility_groupings` per-
    // grouping arrays) that no longer correspond to a configured terminal
    // so deleted-terminal entries don't accumulate in settings.json.
    // See docs/38-terminal-visibility.md §38.7 + docs/39-visibility-groupings.md.
    // HS-7949 — additionally hide any newly-added terminal id in every
    // non-Default grouping. The previous configured set was captured before
    // the write so we can diff (`previousConfiguredIds` vs `configuredIds`).
    // See docs/39-visibility-groupings.md §39.X.
    const { prunedHiddenTerminals, prunedVisibilityGroupings, addNewTerminalsToNonDefaultGroupings, writeFileSettings: writeAgain } = await import('../file-settings.js');
    const { listTerminalConfigs } = await import('../terminals/config.js');
    const configuredIds = new Set(listTerminalConfigs(dataDir).map(t => t.id));
    const prunedFlat = prunedHiddenTerminals(updated.hidden_terminals, configuredIds);
    const prunedGroupings = prunedVisibilityGroupings(updated.visibility_groupings, configuredIds);
    // Compose: start from the post-prune groupings (or the current groupings
    // if no prune was needed), then layer the HS-7949 new-id-hidden-in-non-
    // Default-groupings rule on top. Order matters — pruning must happen
    // first so we don't accidentally re-add an already-removed-but-still-
    // configured id, and the new-id step only ever appends.
    const groupingsAfterPrune = prunedGroupings ?? updated.visibility_groupings;
    const newIds = [...configuredIds].filter(id => !previousConfiguredIds.has(id));
    const groupingsAfterNewHide = addNewTerminalsToNonDefaultGroupings(groupingsAfterPrune, newIds);
    const followup: Record<string, unknown> = {};
    if (prunedFlat !== null) followup.hidden_terminals = prunedFlat;
    if (groupingsAfterNewHide !== null) followup.visibility_groupings = groupingsAfterNewHide;
    else if (prunedGroupings !== null) followup.visibility_groupings = prunedGroupings;
    if (Object.keys(followup).length > 0) writeAgain(dataDir, followup);
  }
  return c.json(updated);
});
