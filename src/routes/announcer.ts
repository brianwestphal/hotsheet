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

import { isAppleFoundationAvailable } from '../announcer/appleFoundation.js';
import { addDismissedTopic, getDismissedTopics, setDismissedTopics } from '../announcer/dismissedTopics.js';
import {
  ANNOUNCER_CURSOR_KEY,
  generateAnnouncementsOnce, listAnnouncerAnthropicModels,
  prepareSummarizationProvider, resolveAnnouncerModel,
} from '../announcer/generate.js';
import { getAnnouncerKeyId, hasAnnouncerKey, setAnnouncerKeyId } from '../announcer/key.js';
import { registerLiveListener, unregisterLiveListener } from '../announcer/liveGenerator.js';
import { isLocalProviderAvailable, listLocalModels } from '../announcer/localProvider.js';
import {
  AdvanceCursorReqSchema, AnnounceReqSchema, GenerateAnnouncementsReqSchema,
  MarkListenedReqSchema, SelectAnnouncerKeyReqSchema,
  SetAnnouncerLiveReqSchema, SetDismissedTopicsReqSchema,
} from '../api/announcer.js';
import {
  clearAnnouncements, dismissAnnouncement, getActiveAnnouncements, insertAnnouncements,
  markAnnouncementListened,
} from '../db/announcer.js';
import { runWithDataDir } from '../db/connection.js';
import { getSettings, updateSetting } from '../db/queries.js';
import { getAllProjects } from '../projects.js';
import type { Visual } from '../schemas.js';
import type { AppEnv } from '../types.js';
import { parseIntParam } from './helpers.js';
import { notifyMutation } from './notify.js';

export const announcerRoutes = new Hono<AppEnv>();

// GET /api/announcer/overview — HS-8762/8758. Cross-project: every project with
// the announcer enabled, plus the active project's secret so the client can
// default the context dropdown ("All Projects" vs a specific project). Each
// project's enabled/key/entry-count is read in that project's own DB context
// via `runWithDataDir` (mirrors the §70 cross-project stats enumeration).
announcerRoutes.get('/announcer/overview', async (c) => {
  const activeSecret = c.get('projectSecret');
  // HS-8790/8792 — machine-global on-device availability (Apple Foundation Models
  // OR a reachable local endpoint). HS-9159 — with the per-project enable toggle
  // gone, the announcer is always-on; a project is "usable" iff a provider is
  // configured (on-device available OR the project has an Anthropic key).
  const appleAvailable = await isAppleFoundationAvailable();
  const localAvailable = await isLocalProviderAvailable();
  // HS-9169 — list EVERY project with a `usable` flag (was: filter to usable
  // only). The context picker renders the unusable ones disabled; the toolbar
  // Listen-button gate still enables when ≥1 project is usable.
  const projects: { secret: string; name: string; enabled: boolean; hasKey: boolean; entryCount: number; usable: boolean }[] = [];
  for (const p of getAllProjects()) {
    const info = await runWithDataDir(p.dataDir, async () => {
      return { hasKey: await hasAnnouncerKey(), entryCount: (await getActiveAnnouncements()).length };
    });
    const usable = appleAvailable || localAvailable || info.hasKey;
    projects.push({ secret: p.secret, name: p.name, enabled: true, hasKey: info.hasKey, entryCount: info.entryCount, usable });
  }
  return c.json({ activeSecret, projects, appleAvailable, localAvailable });
});

// GET /api/announcer/status — opt-in + key + entry-count + cursor.
announcerRoutes.get('/announcer/status', async (c) => {
  const settings = await getSettings();
  const entries = await getActiveAnnouncements();
  return c.json({
    // HS-9159 — the announcer is always-on (the per-project toggle was removed).
    enabled: true,
    hasKey: await hasAnnouncerKey(),
    selectedKeyId: await getAnnouncerKeyId(),
    entryCount: entries.length,
    lastListenedAt: settings[ANNOUNCER_CURSOR_KEY] ?? null,
    // HS-8790 — whether on-device Apple Foundation Models can be used here, so
    // the settings UI can offer + default to it.
    appleAvailable: await isAppleFoundationAvailable(),
    // HS-8792 — whether a local OpenAI-compatible endpoint is reachable, plus the
    // installed-model ids it reports (for the settings model dropdown).
    localAvailable: await isLocalProviderAvailable(),
    localModels: await listLocalModels(),
    // HS-8853 — the Anthropic models the active key actually offers (discovered
    // via the Models API), or the static fallback set. Drives the dropdown so it
    // tracks new/retired Claude models instead of a hardcoded list.
    anthropicModels: await listAnnouncerAnthropicModels(),
  });
});

// POST /api/announcer/generate — collect since cursor → summarize → persist.
// Shares the generate core with the live-mode loop (HS-8750, `generate.ts`).
announcerRoutes.post('/announcer/generate', async (c) => {
  // HS-9159 — always-on; the provider-readiness check below is the sole gate.
  // HS-8764 — model from the global setting; HS-8790/8792 — defaults to an
  // on-device provider when available, else the cheapest Anthropic model. The
  // shared readiness check gates by provider (Anthropic key / Apple helper /
  // local endpoint) and hands back the credential the summarizer needs.
  const model = await resolveAnnouncerModel();
  const { ready, apiKey, error } = await prepareSummarizationProvider(model);
  if (!ready) return c.json({ error: error ?? 'Announcer provider not available' }, 400);

  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = GenerateAnnouncementsReqSchema.safeParse(raw);
  try {
    const { rows, generatedCount } = await generateAnnouncementsOnce({
      dataDir: c.get('dataDir'),
      projectSecret: c.get('projectSecret'),
      apiKey,
      model,
      since: parsed.success ? parsed.data.since : undefined,
    });
    return c.json({ entries: rows, generated: generatedCount });
  } catch (err) {
    // HS-8805 — a summarization failure (e.g. the on-device Apple FM helper
    // exiting code 4, or a transient provider error) is best-effort and
    // RECOVERABLE, not a server fault. Returning 5xx made the client's generic
    // api layer pop the alarming "Connection Error" overlay on dialog open.
    // Respond 200 with the already-generated reel + a soft `error` the client
    // surfaces as a gentle toast, so existing entries still play.
    const message = err instanceof Error ? err.message : 'summarization failed';
    console.warn(`[announcer] generate failed (soft): ${message}`);
    return c.json({ entries: await getActiveAnnouncements(), generated: 0, error: `Summarization failed: ${message}` });
  }
});

// POST /api/announcer/live — HS-8750. Register/renew (enabled:true) or drop
// (enabled:false) this project's live-listen lease. While the lease is live, the
// server-side generator (`liveGenerator.ts`) produces entries as work happens;
// the lease expires if the client stops renewing, so generation is OFF unless
// someone is actively listening (no silent background API spend).
announcerRoutes.post('/announcer/live', async (c) => {
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = SetAnnouncerLiveReqSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid request body' }, 400);
  const secret = c.get('projectSecret');
  if (parsed.data.enabled) {
    // Only honor a live lease for an opted-in + summarizable project. HS-8790/8792
    // — the on-device providers (Apple / local) need no API key, just availability;
    // the shared readiness check covers all three providers.
    const model = await resolveAnnouncerModel();
    const summarizable = (await prepareSummarizationProvider(model)).ready;
    // HS-9159 — always-on; only a usable provider gates the live lease now.
    if (!summarizable) {
      return c.json({ error: 'Announcer has no usable model configured for this project' }, 400);
    }
    registerLiveListener(secret, c.get('dataDir'));
  } else {
    unregisterLiveListener(secret);
  }
  return c.json({ ok: true });
});

// POST /api/announcer/announce — HS-8771. A curated, agent-pushed highlight
// (via the `hotsheet_announce` MCP tool) that pre-empts the derived queue with a
// low-latency, high-intent entry. No AI call — the agent supplies the title +
// script. No-op when the project isn't opted in (so it can't create entries the
// user never sees).
announcerRoutes.post('/announcer/announce', async (c) => {
  // HS-9159 — always-on: an agent-pushed highlight needs no AI provider, so it
  // always inserts (the entry surfaces whenever the user listens).
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = AnnounceReqSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid request body' }, 400);
  // HS-8772 — an optional curated diff becomes a tier-2 visual on the entry.
  const d = parsed.data.diff;
  const visuals: Visual[] = d === undefined
    ? []
    : [{ type: 'diff', oldStr: d.oldStr, newStr: d.newStr, filePath: d.filePath ?? null, replaceAll: d.replaceAll ?? false }];
  const rows = await insertAnnouncements([{ title: parsed.data.title, script: parsed.data.highlight, visuals }], null, null);
  notifyMutation(c.get('dataDir'));
  return c.json({ entries: rows, inserted: rows.length });
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
  await updateSetting(ANNOUNCER_CURSOR_KEY, at);
  return c.json({ ok: true });
});

// POST /api/announcer/listened — HS-8803. Mark an entry listened (now) + reset
// the grace timer for later already-heard entries, so heard pages clear an hour
// after listening rather than piling up. Called by the PIP as the user lands on
// each entry.
announcerRoutes.post('/announcer/listened', async (c) => {
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = MarkListenedReqSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid request body' }, 400);
  await markAnnouncementListened(parsed.data.id);
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
// HS-8769 — also records the entry's title as a dismissed topic so future
// live-mode batches omit similar material.
announcerRoutes.post('/announcer/dismiss/:id', async (c) => {
  const id = parseIntParam(c, 'id');
  if (id === null) return c.json({ error: 'Invalid id' }, 400);
  const row = await dismissAnnouncement(id);
  if (row === null) return c.json({ error: 'Not found' }, 404);
  await addDismissedTopic(row.title);
  notifyMutation(c.get('dataDir'));
  return c.json({ ok: true });
});

// GET /api/announcer/dismissed-topics — the editable "uninteresting" list (HS-8769).
announcerRoutes.get('/announcer/dismissed-topics', async (c) => {
  return c.json({ topics: await getDismissedTopics() });
});

// PUT /api/announcer/dismissed-topics — replace the list (Settings editor).
announcerRoutes.put('/announcer/dismissed-topics', async (c) => {
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = SetDismissedTopicsReqSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid request body' }, 400);
  return c.json({ topics: await setDismissedTopics(parsed.data.topics) });
});

// POST /api/announcer/clear — wipe the reel for this project.
announcerRoutes.post('/announcer/clear', async (c) => {
  await clearAnnouncements();
  notifyMutation(c.get('dataDir'));
  return c.json({ ok: true });
});
