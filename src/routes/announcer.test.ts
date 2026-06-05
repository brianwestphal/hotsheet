/**
 * HS-8745 — announcer route contract: the opt-in gate, derived generate →
 * persist (summarizer mocked), entries, and the listen cursor. Uses a real temp
 * DB; the AI call + keychain are mocked so the test is hermetic.
 */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb, runWithDataDir } from '../db/connection.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import type { AppEnv } from '../types.js';
import { announcerRoutes } from './announcer.js';

vi.mock('../sync/markdown.js', () => ({
  scheduleAllSync: vi.fn(), scheduleWorklistSync: vi.fn(), scheduleOpenTicketsSync: vi.fn(),
  flushPendingSyncs: vi.fn(() => Promise.resolve()), initMarkdownSync: vi.fn(), getSyncState: vi.fn(),
}));
vi.mock('../announcer/summarize.js', () => ({
  ANNOUNCER_MODEL: 'claude-opus-4-8',
  summarizeWork: vi.fn(() => Promise.resolve([
    { title: 'Did stuff', script: 'I did some stuff.' },
    { title: 'More stuff', script: 'And some more.' },
  ])),
}));
vi.mock('../announcer/key.js', () => ({
  resolveAnnouncerKey: vi.fn(() => Promise.resolve('sk-test')),
  hasAnnouncerKey: vi.fn(() => Promise.resolve(true)),
  setAnnouncerKey: vi.fn(() => Promise.resolve(true)),
  deleteAnnouncerKey: vi.fn(() => Promise.resolve(true)),
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

    const entriesRes = await app.request('/api/announcer/entries');
    expect((await entriesRes.json() as { entries: unknown[] }).entries).toHaveLength(2);

    const statusRes = await app.request('/api/announcer/status');
    const status = await statusRes.json() as { enabled: boolean; entryCount: number; hasKey: boolean };
    expect(status).toMatchObject({ enabled: true, entryCount: 2, hasKey: true });
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
});
