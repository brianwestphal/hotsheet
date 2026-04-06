import { existsSync, readdirSync, writeFileSync } from 'fs';
import { Hono } from 'hono';
import { homedir, tmpdir } from 'os';
import { join, relative, resolve } from 'path';

import { getTicketStats } from '../db/queries.js';
import { openInFileManager } from '../open-in-file-manager.js';
import { getAllProjects } from '../projects.js';
import { consumeSkillsCreatedFlag, ensureSkillsForDir } from '../skills.js';
import type { AppEnv } from '../types.js';
import { addPollWaiter, getChangeVersion } from './notify.js';
import { parseBody, PrintSchema } from './validation.js';

export const dashboardRoutes = new Hono<AppEnv>();

// --- Long-poll ---

dashboardRoutes.get('/poll', async (c) => {
  const clientVersion = parseInt(c.req.query('version') ?? '0', 10);
  const changeVersion = getChangeVersion();
  if (changeVersion > clientVersion) {
    return c.json({ version: changeVersion });
  }
  // Wait for a change or timeout after 30s
  const version = await Promise.race([
    new Promise<number>((resolve) => { addPollWaiter(resolve); }),
    new Promise<number>((resolve) => { setTimeout(() => resolve(getChangeVersion()), 30000); }),
  ]);
  return c.json({ version });
});

// --- Stats ---

dashboardRoutes.get('/stats', async (c) => {
  const stats = await getTicketStats();
  return c.json(stats);
});

dashboardRoutes.get('/dashboard', async (c) => {
  const { getDashboardStats, getSnapshots } = await import('../db/stats.js');
  const days = parseInt(c.req.query('days') ?? '30', 10);
  const [stats, snapshots] = await Promise.all([
    getDashboardStats(days),
    getSnapshots(days),
  ]);
  return c.json({ ...stats, snapshots });
});

// --- Worklist info & Claude skill ---

dashboardRoutes.get('/worklist-info', (c) => {
  const dataDir = c.get('dataDir');
  const cwd = process.cwd();
  const worklistRel = relative(cwd, join(dataDir, 'worklist.md'));
  const prompt = `Read ${worklistRel} for current work items.`;

  // Ensure skills are up-to-date for all projects
  for (const p of getAllProjects()) {
    ensureSkillsForDir(p.dataDir.replace(/\/.hotsheet\/?$/, ''));
  }
  const skillCreated = consumeSkillsCreatedFlag();

  return c.json({ prompt, skillCreated });
});

// --- Browse directories (for Open Folder dialog) ---

dashboardRoutes.get('/browse', (c) => {
  const requestedPath = c.req.query('path') ?? homedir();
  const absPath = resolve(requestedPath);

  if (!existsSync(absPath)) {
    return c.json({ error: 'Path does not exist', path: absPath }, 404);
  }

  try {
    const entries = readdirSync(absPath, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => ({
        name: e.name,
        path: join(absPath, e.name),
        hasHotsheet: existsSync(join(absPath, e.name, '.hotsheet')),
      }));

    const parentPath = resolve(absPath, '..');
    return c.json({
      path: absPath,
      parent: parentPath !== absPath ? parentPath : null,
      entries,
      hasHotsheet: existsSync(join(absPath, '.hotsheet')),
    });
  } catch {
    return c.json({ error: 'Cannot read directory', path: absPath }, 403);
  }
});

// --- Global config ---

dashboardRoutes.get('/global-config', async (c) => {
  const { readGlobalConfig } = await import('../global-config.js');
  return c.json(readGlobalConfig());
});

// --- Ensure skills ---

dashboardRoutes.post('/ensure-skills', (c) => {
  // Ensure skills for ALL registered projects, not just the active one
  for (const p of getAllProjects()) {
    const projectRoot = p.dataDir.replace(/\/.hotsheet\/?$/, '');
    ensureSkillsForDir(projectRoot);
  }
  const updated = consumeSkillsCreatedFlag();
  return c.json({ updated });
});

// --- Glassbox integration ---

let glassboxAvailable: boolean | null = null;

dashboardRoutes.get('/glassbox/status', async (c) => {
  if (glassboxAvailable === null) {
    const { execFileSync } = await import('child_process');
    try {
      execFileSync('which', ['glassbox'], { stdio: 'ignore' });
      glassboxAvailable = true;
    } catch {
      glassboxAvailable = false;
    }
  }
  return c.json({ available: glassboxAvailable });
});

dashboardRoutes.post('/glassbox/launch', async (c) => {
  if (glassboxAvailable !== true) return c.json({ error: 'Glassbox not available' }, 404);
  const { spawn } = await import('child_process');
  spawn('glassbox', [], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
  }).unref();
  return c.json({ ok: true });
});

// --- Gitignore ---

dashboardRoutes.get('/gitignore/status', async (c) => {
  const { isGitRepo, isHotsheetGitignored } = await import('../gitignore.js');
  const cwd = process.cwd();
  if (!isGitRepo(cwd)) return c.json({ inGitRepo: false, ignored: false });
  return c.json({ inGitRepo: true, ignored: isHotsheetGitignored(cwd) });
});

dashboardRoutes.post('/gitignore/add', async (c) => {
  const { ensureGitignore } = await import('../gitignore.js');
  ensureGitignore(process.cwd());
  return c.json({ ok: true });
});

// --- Print (Tauri) ---

dashboardRoutes.post('/print', async (c) => {
  const raw: unknown = await c.req.json();
  const parsed = parseBody(PrintSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);

  const tmpPath = join(tmpdir(), `hotsheet-print-${Date.now()}.html`);
  writeFileSync(tmpPath, parsed.data.html, 'utf-8');

  // Open in default browser
  await openInFileManager(tmpPath);

  return c.json({ ok: true, path: tmpPath });
});
