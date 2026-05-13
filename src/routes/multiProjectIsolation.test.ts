/**
 * HS-8340 — multi-project isolation tests for the ticket-list +
 * per-ID endpoints. The reported bug was: `GET /api/tickets` (without
 * an id) on a kerf instance was returning HS-prefixed tickets even
 * though `GET /api/tickets/:id` correctly returned KF tickets and
 * `POST` correctly created KF tickets. The most likely cause is a
 * caller-side inconsistency (mutations + per-ID fetches authed via
 * `X-Hotsheet-Secret`, but the LIST endpoint called without any
 * auth — server then falls back to the default dataDir which would
 * be a different project's DB).
 *
 * These tests pin the server-side contract: when a request carries
 * a valid project secret (header or `?project=<secret>` query
 * param), both LIST and per-ID endpoints must resolve to THE SAME
 * project's data. When NEITHER is present, both endpoints must fall
 * back to the SAME default dataDir.
 *
 * The pre-bug-fix LIST endpoint already routed through `getDb()` →
 * `requestDataDir.getStore()` (AsyncLocalStorage set by the
 * `runWithDataDir(...)` middleware in `server.ts`), so these tests
 * are a regression guard against any future change that breaks
 * that isolation — for example a future helper that takes a raw
 * dataDir argument instead of going through `getDb()`, or a
 * background task that escapes the AsyncLocalStorage context.
 */
import { mkdirSync, rmSync } from 'fs';
import { Hono } from 'hono';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { closeAllDatabases, getDbForDir, runWithDataDir } from '../db/connection.js';
import type { AppEnv } from '../types.js';
import { apiRoutes } from './api.js';

interface TicketResponse {
  id: number;
  title: string;
  ticket_number: string;
}

// Mock the side-effecty modules so the tests don't touch the user's filesystem.
vi.mock('../sync/markdown.js', () => ({
  scheduleAllSync: vi.fn(),
  scheduleWorklistSync: vi.fn(),
  scheduleOpenTicketsSync: vi.fn(),
  flushPendingSyncs: vi.fn(() => Promise.resolve()),
  initMarkdownSync: vi.fn(),
}));
vi.mock('../skills.js', () => ({
  ensureSkills: vi.fn(() => []),
  consumeSkillsCreatedFlag: vi.fn(() => false),
  initSkills: vi.fn(),
  SKILL_VERSION: 2,
  parseVersionHeader: vi.fn(),
  updateFile: vi.fn(),
}));
vi.mock('../channel-config.js', () => ({
  isChannelAlive: vi.fn(() => Promise.resolve(false)),
  getChannelPort: vi.fn(() => null),
  registerChannel: vi.fn(),
  registerChannelForAll: vi.fn(),
  unregisterChannel: vi.fn(),
  unregisterChannelForAll: vi.fn(),
  shutdownChannel: vi.fn(() => Promise.resolve()),
  triggerChannel: vi.fn(() => Promise.resolve(true)),
  checkChannelVersion: vi.fn(() => Promise.resolve(null)),
}));

interface Project {
  name: string;
  secret: string;
  dataDir: string;
}

const PROJECTS: Project[] = [];

// Replicate the server.ts middleware logic so the test mirrors the
// real request handling — resolves dataDir from `X-Hotsheet-Secret`
// header OR `?project=<secret>` query param, then runs the route
// handler inside `runWithDataDir(...)` so `getDb()` resolves to the
// correct project's database.
function getProjectBySecret(secret: string): Project | undefined {
  return PROJECTS.find(p => p.secret === secret);
}

let app: Hono<AppEnv>;
let defaultProject: Project;

// HS-8340 followup — the beforeAll hook below initializes two PGLite
// databases (one per project). Each init runs the schema migrations
// against a fresh tmpdir-rooted dataDir. Under full-parallel-suite
// load that work routinely exceeds vitest's default 10s hook budget
// (the test passes in isolation at ~10s but contends with other
// PGLite-using tests in the parallel suite). Bumping the hook budget
// to 60s eliminates the cross-suite flake observed in prior commits
// (see e.g. `HS-8364 / HS-8365` commit message `the 1 'failed' test
// file is pre-existing flake from concurrent localhost-port use across
// the parallel suite`) without changing test behavior.
beforeAll(async () => {
  // Set up two projects with distinct dataDirs.
  const baseDir = tmpdir();
  const kfDir = join(baseDir, `hs-test-iso-kf-${Date.now()}`);
  const hsDir = join(baseDir, `hs-test-iso-hs-${Date.now()}`);
  mkdirSync(kfDir, { recursive: true });
  mkdirSync(hsDir, { recursive: true });

  PROJECTS.push(
    { name: 'kerf', secret: 'secret-kf', dataDir: kfDir },
    { name: 'hs', secret: 'secret-hs', dataDir: hsDir },
  );
  defaultProject = PROJECTS[0]; // kerf is the default

  // Initialize both DBs.
  await getDbForDir(kfDir);
  await getDbForDir(hsDir);

  app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    let resolvedDataDir = defaultProject.dataDir;
    const headerSecret = c.req.header('X-Hotsheet-Secret');
    if (headerSecret !== undefined && headerSecret !== '') {
      const project = getProjectBySecret(headerSecret);
      if (project) resolvedDataDir = project.dataDir;
    } else {
      const projectParam = c.req.query('project');
      if (projectParam !== undefined && projectParam !== '') {
        const project = getProjectBySecret(projectParam);
        if (project) resolvedDataDir = project.dataDir;
      }
    }
    c.set('dataDir', resolvedDataDir);
    c.set('projectSecret', PROJECTS.find(p => p.dataDir === resolvedDataDir)?.secret ?? '');
    await runWithDataDir(resolvedDataDir, () => next());
  });
  app.route('/api', apiRoutes);
}, 60_000);

afterAll(async () => {
  await closeAllDatabases();
  for (const p of PROJECTS) {
    try { rmSync(p.dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}, 60_000);

async function createTicket(secret: string, title: string): Promise<TicketResponse> {
  const res = await app.request('/api/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret },
    body: JSON.stringify({ title }),
  });
  expect(res.status).toBe(201);
  return await res.json() as TicketResponse;
}

describe('HS-8340 — multi-project data isolation', () => {
  it('GET /api/tickets respects X-Hotsheet-Secret header → returns only the project\'s tickets', async () => {
    const kfTicket = await createTicket('secret-kf', 'kerf-only ticket');
    const hsTicket = await createTicket('secret-hs', 'hs-only ticket');

    // List with kerf secret → only kerf tickets.
    const kfRes = await app.request('/api/tickets', {
      headers: { 'X-Hotsheet-Secret': 'secret-kf' },
    });
    expect(kfRes.status).toBe(200);
    const kfList = await kfRes.json() as TicketResponse[];
    expect(kfList.some(t => t.id === kfTicket.id)).toBe(true);
    expect(kfList.some(t => t.id === hsTicket.id && t.title === 'hs-only ticket')).toBe(false);

    // List with hs secret → only hs tickets.
    const hsRes = await app.request('/api/tickets', {
      headers: { 'X-Hotsheet-Secret': 'secret-hs' },
    });
    expect(hsRes.status).toBe(200);
    const hsList = await hsRes.json() as TicketResponse[];
    expect(hsList.some(t => t.id === hsTicket.id)).toBe(true);
    expect(hsList.some(t => t.title === 'kerf-only ticket')).toBe(false);
  });

  it('GET /api/tickets respects ?project=<secret> query param', async () => {
    // Use the same projects from the previous test (data persists across `it` in this describe).
    const kfRes = await app.request('/api/tickets?project=secret-kf');
    expect(kfRes.status).toBe(200);
    const kfList = await kfRes.json() as TicketResponse[];
    expect(kfList.some(t => t.title === 'kerf-only ticket')).toBe(true);
    expect(kfList.some(t => t.title === 'hs-only ticket')).toBe(false);

    const hsRes = await app.request('/api/tickets?project=secret-hs');
    expect(hsRes.status).toBe(200);
    const hsList = await hsRes.json() as TicketResponse[];
    expect(hsList.some(t => t.title === 'hs-only ticket')).toBe(true);
    expect(hsList.some(t => t.title === 'kerf-only ticket')).toBe(false);
  });

  it('GET /api/tickets/:id respects X-Hotsheet-Secret header (parity with the LIST endpoint)', async () => {
    // Create a fresh ticket in kerf so we have a known id.
    const t = await createTicket('secret-kf', 'kerf id-fetch ticket');

    // Fetching with the kerf secret returns the ticket.
    const okRes = await app.request(`/api/tickets/${t.id}`, {
      headers: { 'X-Hotsheet-Secret': 'secret-kf' },
    });
    expect(okRes.status).toBe(200);
    const okData = await okRes.json() as TicketResponse;
    expect(okData.id).toBe(t.id);
    expect(okData.title).toBe('kerf id-fetch ticket');

    // Fetching the same id with the hs secret should NOT return the kerf ticket
    // (might 404 if the id doesn't exist in hs, or return a different
    // ticket if it happens to coincide — either way it should not be the
    // kerf ticket we created). Assert via the title not matching.
    const otherRes = await app.request(`/api/tickets/${t.id}`, {
      headers: { 'X-Hotsheet-Secret': 'secret-hs' },
    });
    if (otherRes.status === 200) {
      const otherData = await otherRes.json() as TicketResponse;
      expect(otherData.title).not.toBe('kerf id-fetch ticket');
    } else {
      expect(otherRes.status).toBe(404);
    }
  });

  it('GET /api/tickets and GET /api/tickets/:id resolve to the SAME dataDir for the same request auth', async () => {
    // The bug-report shape: LIST returns wrong-project tickets while per-ID returns
    // correct-project tickets. This test pins that both endpoints resolve to the
    // same dataDir when given the same auth — so any future regression that breaks
    // the symmetry will fail this test.
    const created = await createTicket('secret-hs', 'parity-check ticket');

    const listRes = await app.request('/api/tickets', {
      headers: { 'X-Hotsheet-Secret': 'secret-hs' },
    });
    const list = await listRes.json() as TicketResponse[];
    const listHasIt = list.some(t => t.id === created.id);
    expect(listHasIt).toBe(true);

    const idRes = await app.request(`/api/tickets/${created.id}`, {
      headers: { 'X-Hotsheet-Secret': 'secret-hs' },
    });
    expect(idRes.status).toBe(200);
    const idData = await idRes.json() as TicketResponse;
    expect(idData.id).toBe(created.id);
    expect(idData.title).toBe('parity-check ticket');
  });

  it('without any auth, both LIST and per-ID fall back to the default project\'s dataDir', async () => {
    // Create a fresh ticket in the default project (kerf) via the explicit secret
    // so we know it exists. Then call WITHOUT any auth and verify the LIST returns
    // it AND a per-ID fetch returns it — both must hit the same default dataDir.
    const t = await createTicket('secret-kf', 'default-fallback ticket');

    const listRes = await app.request('/api/tickets');
    expect(listRes.status).toBe(200);
    const list = await listRes.json() as TicketResponse[];
    expect(list.some(item => item.id === t.id)).toBe(true);

    const idRes = await app.request(`/api/tickets/${t.id}`);
    expect(idRes.status).toBe(200);
    const idData = await idRes.json() as TicketResponse;
    expect(idData.id).toBe(t.id);
  });

  it('invalid X-Hotsheet-Secret falls back to the default project (does NOT leak across projects)', async () => {
    // A garbage secret matches no project → middleware falls back to default.
    // The LIST endpoint should return the default project's tickets, NOT some
    // other project's. Same for per-ID. This pins the fallback shape.
    const kfList = await app.request('/api/tickets', {
      headers: { 'X-Hotsheet-Secret': 'secret-kf' },
    });
    const kfTickets = await kfList.json() as TicketResponse[];

    const fallbackRes = await app.request('/api/tickets', {
      headers: { 'X-Hotsheet-Secret': 'totally-invalid-secret' },
    });
    expect(fallbackRes.status).toBe(200);
    const fallbackList = await fallbackRes.json() as TicketResponse[];
    // Default is kerf — the fallback list should match kerf's list.
    expect(fallbackList.length).toBe(kfTickets.length);
    const fallbackIds = new Set(fallbackList.map(t => t.id));
    for (const t of kfTickets) {
      expect(fallbackIds.has(t.id)).toBe(true);
    }
  });
});
