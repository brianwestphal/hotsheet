/**
 * §78 Announcer (HS-8745) — server endpoints for the after-the-fact audio MVP.
 *
 * Generation is derived + decoupled: collect work signals since the per-project
 * cursor (`collectWorkSignals`), summarize them with the user's Anthropic key
 * (`summarizeWork`), and persist the resulting entries (`announcements` table).
 * The cursor (`announcer_last_listened_at`) advances when the user *listens*
 * (POST /cursor), not at generate time. The Phase 1b client drives playback +
 * TTS off these endpoints.
 */
import { Hono } from 'hono';

import { collectWorkSignals } from '../announcer/collectSignals.js';
import { getAnnouncerKeyId, hasAnnouncerKey, resolveAnnouncerKey, setAnnouncerKeyId } from '../announcer/key.js';
import { DEFAULT_ANNOUNCER_MODEL } from '../announcer/models.js';
import { summarizeWork } from '../announcer/summarize.js';
import {
  AdvanceCursorReqSchema, GenerateAnnouncementsReqSchema,
  SelectAnnouncerKeyReqSchema, SetAnnouncerEnabledReqSchema,
} from '../api/announcer.js';
import {
  clearAnnouncements, dismissAnnouncement, getActiveAnnouncements,
  getLatestCoversTo, insertAnnouncements,
} from '../db/announcer.js';
import { recordAnnouncerUsage } from '../db/announcerUsage.js';
import { runWithDataDir } from '../db/connection.js';
import { getSettings, updateSetting } from '../db/queries.js';
import { readGlobalConfig } from '../global-config.js';
import { getAllProjects } from '../projects.js';
import type { AppEnv } from '../types.js';
import { parseIntParam } from './helpers.js';
import { notifyMutation } from './notify.js';

export const announcerRoutes = new Hono<AppEnv>();

const ENABLED_KEY = 'announcer_enabled';
const CURSOR_KEY = 'announcer_last_listened_at';

async function isEnabled(): Promise<boolean> {
  return (await getSettings())[ENABLED_KEY] === 'true';
}

/** Latest of (last-listened cursor, last-generated covers_to) — so a re-generate
 *  picks up where it left off rather than re-covering unheard work. */
async function effectiveSince(override?: string): Promise<string | null> {
  if (override !== undefined && override !== '') return override;
  const cursor = (await getSettings())[CURSOR_KEY];
  const latest = await getLatestCoversTo();
  const candidates = [cursor, latest].filter((v): v is string => typeof v === 'string' && v !== '');
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a > b ? a : b));
}

// GET /api/announcer/overview — HS-8762/8758. Cross-project: every project with
// the announcer enabled, plus the active project's secret so the client can
// default the context dropdown ("All Projects" vs a specific project). Each
// project's enabled/key/entry-count is read in that project's own DB context
// via `runWithDataDir` (mirrors the §70 cross-project stats enumeration).
announcerRoutes.get('/announcer/overview', async (c) => {
  const activeSecret = c.get('projectSecret');
  const projects: { secret: string; name: string; enabled: boolean; hasKey: boolean; entryCount: number }[] = [];
  for (const p of getAllProjects()) {
    const info = await runWithDataDir(p.dataDir, async () => {
      if ((await getSettings())[ENABLED_KEY] !== 'true') return null;
      return { hasKey: await hasAnnouncerKey(), entryCount: (await getActiveAnnouncements()).length };
    });
    if (info !== null) {
      projects.push({ secret: p.secret, name: p.name, enabled: true, hasKey: info.hasKey, entryCount: info.entryCount });
    }
  }
  return c.json({ activeSecret, projects });
});

// GET /api/announcer/status — opt-in + key + entry-count + cursor.
announcerRoutes.get('/announcer/status', async (c) => {
  const settings = await getSettings();
  const entries = await getActiveAnnouncements();
  return c.json({
    enabled: settings[ENABLED_KEY] === 'true',
    hasKey: await hasAnnouncerKey(),
    selectedKeyId: await getAnnouncerKeyId(),
    entryCount: entries.length,
    lastListenedAt: settings[CURSOR_KEY] ?? null,
  });
});

// POST /api/announcer/generate — collect since cursor → summarize → persist.
announcerRoutes.post('/announcer/generate', async (c) => {
  if (!(await isEnabled())) return c.json({ error: 'Announcer is not enabled for this project' }, 400);
  const apiKey = await resolveAnnouncerKey();
  if (apiKey === null) return c.json({ error: 'No Anthropic API key configured' }, 400);

  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = GenerateAnnouncementsReqSchema.safeParse(raw);
  const since = await effectiveSince(parsed.success ? parsed.data.since : undefined);

  const signals = await collectWorkSignals(since);
  if (signals.count === 0) return c.json({ entries: [], generated: 0 });

  // HS-8764 — model comes from the global setting (defaults to the cheapest
  // model inside `summarizeWork` when unset).
  const model = readGlobalConfig().announcerModel ?? DEFAULT_ANNOUNCER_MODEL;
  let result;
  try {
    result = await summarizeWork(signals.material, { apiKey, model });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'summarization failed';
    return c.json({ error: `Summarization failed: ${message}` }, 502);
  }

  // HS-8766 — record token usage + cost for the stats dashboards (the call
  // happened even if it produced 0 usable entries).
  if (result.usage !== null) {
    await recordAnnouncerUsage({
      projectSecret: c.get('projectSecret'),
      model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
  }

  const rows = await insertAnnouncements(result.entries, signals.coversFrom, signals.coversTo);
  notifyMutation(c.get('dataDir'));
  return c.json({ entries: rows, generated: rows.length });
});

// GET /api/announcer/entries — active (undismissed) entries in playback order.
announcerRoutes.get('/announcer/entries', async (c) => {
  return c.json({ entries: await getActiveAnnouncements() });
});

// POST /api/announcer/cursor — advance the last-listened mark (after playback).
announcerRoutes.post('/announcer/cursor', async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = AdvanceCursorReqSchema.safeParse(raw);
  const at = parsed.success && parsed.data.at !== undefined ? parsed.data.at : new Date().toISOString();
  await updateSetting(CURSOR_KEY, at);
  return c.json({ ok: true });
});

// POST /api/announcer/enabled — per-project opt-in toggle.
announcerRoutes.post('/announcer/enabled', async (c) => {
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = SetAnnouncerEnabledReqSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid request body' }, 400);
  await updateSetting(ENABLED_KEY, parsed.data.enabled ? 'true' : 'false');
  return c.json({ ok: true });
});

// POST /api/announcer/key-selection — choose which registry key (by id) this
// project uses (null = fall back to the first Anthropic key). HS-8751.
announcerRoutes.post('/announcer/key-selection', async (c) => {
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = SelectAnnouncerKeyReqSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid request body' }, 400);
  await setAnnouncerKeyId(parsed.data.keyId);
  return c.json({ ok: true });
});

// POST /api/announcer/dismiss/:id — "mark uninteresting" a single entry.
announcerRoutes.post('/announcer/dismiss/:id', async (c) => {
  const id = parseIntParam(c, 'id');
  if (id === null) return c.json({ error: 'Invalid id' }, 400);
  const row = await dismissAnnouncement(id);
  if (row === null) return c.json({ error: 'Not found' }, 404);
  notifyMutation(c.get('dataDir'));
  return c.json({ ok: true });
});

// POST /api/announcer/clear — wipe the reel for this project.
announcerRoutes.post('/announcer/clear', async (c) => {
  await clearAnnouncements();
  notifyMutation(c.get('dataDir'));
  return c.json({ ok: true });
});
