import { Hono } from 'hono';
import { join, relative } from 'path';

import { getTicketStats } from '../db/queries.js';
import { consumeSkillsCreatedFlag, ensureSkills } from '../skills.js';
import type { AppEnv } from '../types.js';
import { addPollWaiter, getChangeVersion } from './notify.js';

export const dashboardRoutes = new Hono<AppEnv>();

// --- Long-poll ---

dashboardRoutes.get('/poll', async (c) => {
  const clientVersion = parseInt(c.req.query('version') || '0', 10);
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
  const days = parseInt(c.req.query('days') || '30', 10);
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

  // Ensure skills are up-to-date (version/port changes)
  ensureSkills();
  const skillCreated = consumeSkillsCreatedFlag();

  return c.json({ prompt, skillCreated });
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
  if (!glassboxAvailable) return c.json({ error: 'Glassbox not available' }, 404);
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
  const { html } = await c.req.json<{ html: string }>();
  const { writeFileSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join: pathJoin } = await import('path');
  const { execFile } = await import('child_process');

  const tmpPath = pathJoin(tmpdir(), `hotsheet-print-${Date.now()}.html`);
  writeFileSync(tmpPath, html, 'utf-8');

  // Open in default browser
  const platform = process.platform;
  if (platform === 'darwin') {
    execFile('open', [tmpPath]);
  } else if (platform === 'win32') {
    execFile('start', ['', tmpPath], { shell: true });
  } else {
    execFile('xdg-open', [tmpPath]);
  }

  return c.json({ ok: true, path: tmpPath });
});
