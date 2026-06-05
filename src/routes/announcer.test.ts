/**
 * HS-8745 — announcer route contract: the opt-in gate, derived generate →
 * persist (summarizer mocked), entries, and the listen cursor. Uses a real temp
 * DB; the AI call + keychain are mocked so the test is hermetic.
 */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerLiveListener, unregisterLiveListener } from '../announcer/liveGenerator.js';
import { summarizeWork } from '../announcer/summarize.js';
import { recordAnnouncerUsage } from '../db/announcerUsage.js';
import { getDb, runWithDataDir } from '../db/connection.js';
import type { ProjectContext } from '../projects.js';
import { getAllProjects } from '../projects.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import type { AppEnv } from '../types.js';
import { announcerRoutes } from './announcer.js';

vi.mock('../sync/markdown.js', () => ({
  scheduleAllSync: vi.fn(), scheduleWorklistSync: vi.fn(), scheduleOpenTicketsSync: vi.fn(),
  flushPendingSyncs: vi.fn(() => Promise.resolve()), initMarkdownSync: vi.fn(), getSyncState: vi.fn(),
}));
vi.mock('../announcer/summarize.js', () => ({
  ANNOUNCER_MODEL: 'claude-opus-4-8',
  summarizeWork: vi.fn(() => Promise.resolve({
    entries: [
      { title: 'Did stuff', script: 'I did some stuff.' },
      { title: 'More stuff', script: 'And some more.' },
    ],
    usage: { inputTokens: 1200, outputTokens: 80 },
  })),
}));
vi.mock('../announcer/key.js', () => ({
  resolveAnnouncerKey: vi.fn(() => Promise.resolve('sk-test')),
  hasAnnouncerKey: vi.fn(() => Promise.resolve(true)),
  getAnnouncerKeyId: vi.fn(() => Promise.resolve(null)),
  setAnnouncerKeyId: vi.fn(() => Promise.resolve()),
}));
// HS-8762 — the overview endpoint enumerates registered projects; mock the
// registry so a single fake project points at this test's temp DB.
vi.mock('../projects.js', () => ({ getAllProjects: vi.fn(() => []) }));
// HS-8764 — generate reads the global summarization model from the global config.
vi.mock('../global-config.js', () => ({ readGlobalConfig: vi.fn(() => ({ announcerModel: 'claude-sonnet-4-6' })) }));
// HS-8766 — usage recording goes to the shared telemetry DB; mock it so the
// route test stays decoupled from that store (covered by announcerUsage.test.ts).
vi.mock('../db/announcerUsage.js', () => ({ recordAnnouncerUsage: vi.fn(() => Promise.resolve()) }));
// HS-8750 — the /live route just registers a lease; mock the generator so the
// real change-version loop isn't started here (covered by liveGenerator.test.ts).
vi.mock('../announcer/liveGenerator.js', () => ({
  registerLiveListener: vi.fn(), unregisterLiveListener: vi.fn(),
}));

let tempDir: string;
let app: Hono<AppEnv>;

beforeAll(async () => {
  tempDir = await setupTestDb();
  app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { c.set('dataDir', tempDir); c.set('projectSecret', ''); await runWithDataDir(tempDir, () => next()); });
  app.route('/api', announcerRoutes);
});
afterAll(async () => { await cleanupTestDb(tempDir); });
beforeEach(async () => {
  const db = await getDb();
  await db.query('DELETE FROM announcements');
  await db.query('DELETE FROM command_log');
  await db.query(`DELETE FROM settings WHERE key LIKE 'announcer%'`);
});

const post = (path: string, body?: unknown) => app.request(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
});

describe('announcer routes (HS-8745)', () => {
  it('generate is gated on the per-project opt-in', async () => {
    const res = await post('/api/announcer/generate');
    expect(res.status).toBe(400); // not enabled
  });

  it('enable → generate persists summarized entries → entries + status reflect them', async () => {
    expect((await post('/api/announcer/enabled', { enabled: true })).status).toBe(200);
    // Seed a work signal so collectWorkSignals has material.
    await (await getDb()).query(`INSERT INTO command_log (event_type, direction, summary, detail) VALUES ('done','incoming','finished the export feature','')`);

    const genRes = await post('/api/announcer/generate');
    expect(genRes.status).toBe(200);
    expect((await genRes.json() as { generated: number }).generated).toBe(2);

    // HS-8764 — the global summarization model is forwarded to the summarizer.
    expect(vi.mocked(summarizeWork)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ apiKey: 'sk-test', model: 'claude-sonnet-4-6' }),
    );

    // HS-8766 — the generation's token usage is recorded (model + tokens).
    expect(vi.mocked(recordAnnouncerUsage)).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6', inputTokens: 1200, outputTokens: 80 }),
    );

    const entriesRes = await app.request('/api/announcer/entries');
    expect((await entriesRes.json() as { entries: unknown[] }).entries).toHaveLength(2);

    const statusRes = await app.request('/api/announcer/status');
    const status = await statusRes.json() as { enabled: boolean; entryCount: number; hasKey: boolean; selectedKeyId: string | null };
    expect(status).toMatchObject({ enabled: true, entryCount: 2, hasKey: true, selectedKeyId: null });
  });

  it('generate with no new signals returns generated:0', async () => {
    await post('/api/announcer/enabled', { enabled: true });
    const res = await post('/api/announcer/generate');
    expect(res.status).toBe(200);
    expect((await res.json() as { generated: number }).generated).toBe(0);
  });

  it('cursor advances the last-listened mark', async () => {
    await post('/api/announcer/cursor', { at: '2026-06-05T09:00:00.000Z' });
    const status = await (await app.request('/api/announcer/status')).json() as { lastListenedAt: string | null };
    expect(status.lastListenedAt).toBe('2026-06-05T09:00:00.000Z');
  });

  // HS-8750 — live-listen lease registration, gated on opt-in + key.
  it('live registration requires opt-in, then registers/unregisters the lease', async () => {
    vi.mocked(registerLiveListener).mockClear();
    vi.mocked(unregisterLiveListener).mockClear();

    // Explicitly disabled (set via the route — getSettings is cached, so the
    // raw beforeEach DELETE alone wouldn't flip it) → 400, no registration.
    await post('/api/announcer/enabled', { enabled: false });
    expect((await post('/api/announcer/live', { enabled: true })).status).toBe(400);
    expect(registerLiveListener).not.toHaveBeenCalled();

    // Enable → register a live lease.
    await post('/api/announcer/enabled', { enabled: true });
    expect((await post('/api/announcer/live', { enabled: true })).status).toBe(200);
    expect(registerLiveListener).toHaveBeenCalledTimes(1);

    // Disable the lease.
    expect((await post('/api/announcer/live', { enabled: false })).status).toBe(200);
    expect(unregisterLiveListener).toHaveBeenCalledTimes(1);

    // Bad body → 400.
    expect((await post('/api/announcer/live', { nope: 1 })).status).toBe(400);
  });

  // HS-8771 — the curated announce endpoint (hotsheet_announce MCP tool).
  it('announce inserts a curated entry when enabled, no-ops when disabled', async () => {
    await post('/api/announcer/enabled', { enabled: false });
    expect(((await (await post('/api/announcer/announce', { title: 'T', highlight: 'H' })).json()) as { inserted: number }).inserted).toBe(0);

    await post('/api/announcer/enabled', { enabled: true });
    expect(((await (await post('/api/announcer/announce', { title: 'Shipped', highlight: 'It shipped.' })).json()) as { inserted: number }).inserted).toBe(1);
    const entries = await (await app.request('/api/announcer/entries')).json() as { entries: { title: string }[] };
    expect(entries.entries.some(e => e.title === 'Shipped')).toBe(true);

    expect((await post('/api/announcer/announce', { title: 'x' })).status).toBe(400); // missing highlight
  });

  // HS-8769 — skipping an entry records its title; the list is editable.
  it('dismiss records the title as a dismissed topic; topics get/put', async () => {
    const ins = await (await getDb()).query<{ id: number }>(
      `INSERT INTO announcements (title, script, position) VALUES ('Noisy lint run', 'x', 1) RETURNING id`,
    );
    expect((await post(`/api/announcer/dismiss/${String(ins.rows[0].id)}`)).status).toBe(200);

    const got = await (await app.request('/api/announcer/dismissed-topics')).json() as { topics: string[] };
    expect(got.topics).toContain('Noisy lint run');

    // PUT replaces + normalizes (dedupe/blank-drop).
    const putRes = await app.request('/api/announcer/dismissed-topics', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topics: ['only this', '', 'only this'] }),
    });
    expect((await putRes.json() as { topics: string[] }).topics).toEqual(['only this']);
  });

  // HS-8762 — cross-project overview: only enabled projects, with their key +
  // entry-count read in each project's own DB context.
  it('overview lists only enabled projects with key + entry-count', async () => {
    const fakeProject = { secret: 'sec1', name: 'Proj One', dataDir: tempDir } as unknown as ProjectContext;
    vi.mocked(getAllProjects).mockReturnValue([fakeProject]);

    // Enable + seed two entries → overview includes the project.
    await post('/api/announcer/enabled', { enabled: true });
    await (await getDb()).query(`INSERT INTO announcements (title, script, position) VALUES ('A','a',1), ('B','b',2)`);

    let overview = await (await app.request('/api/announcer/overview')).json() as { activeSecret: string; projects: { secret: string; name: string; enabled: boolean; hasKey: boolean; entryCount: number }[] };
    expect(overview.projects).toEqual([
      { secret: 'sec1', name: 'Proj One', enabled: true, hasKey: true, entryCount: 2 },
    ]);

    // Disabled → excluded from the overview.
    await post('/api/announcer/enabled', { enabled: false });
    overview = await (await app.request('/api/announcer/overview')).json() as { activeSecret: string; projects: { secret: string; name: string; enabled: boolean; hasKey: boolean; entryCount: number }[] };
    expect(overview.projects).toHaveLength(0);
  });
});
