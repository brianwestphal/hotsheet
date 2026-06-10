import { existsSync, readdirSync, writeFileSync } from 'fs';
import { Hono } from 'hono';
import { homedir, tmpdir } from 'os';
import { join, relative, resolve } from 'path';

import { markProjectActive } from '../activeProjects.js';
import { type GlassboxReviewReq, GlassboxReviewReqSchema } from '../api/git.js';
import { getTicketStats } from '../db/queries.js';
import { getSidebarCounts } from '../db/sidebarCounts.js';
import { getDashboardStats, getSnapshots } from '../db/stats.js';
import { ensureGitignore, isGitRepo, isHotsheetGitignored } from '../gitignore.js';
import { readGlobalConfig, writeGlobalConfig } from '../global-config.js';
import { openInFileManager } from '../open-in-file-manager.js';
import { getAllProjects } from '../projects.js';
import { consumeSkillsCreatedFlag, ensureSkillsForDir } from '../skills.js';
import type { AppEnv } from '../types.js';
import { extraSearchDirs } from '../utils/isExecutableOnPath.js';
import { addPollWaiter, getChangeVersion, getDataVersion } from './notify.js';
import { GlobalConfigSchema,parseBody, PrintSchema } from './validation.js';

export const dashboardRoutes = new Hono<AppEnv>();

// --- Long-poll ---

dashboardRoutes.get('/poll', async (c) => {
  // HS-8725 — the poll is always scoped to the project the webview is showing,
  // so each wake marks that project "active" (foreground). The git watcher reads
  // this to skip proactive refresh for background projects (docs/75 §75.3 P3).
  markProjectActive(c.get('dataDir'));
  const clientVersion = Math.max(0, parseInt(c.req.query('version') ?? '0', 10) || 0);
  const changeVersion = getChangeVersion();
  if (changeVersion > clientVersion) {
    return c.json({ version: changeVersion, dataVersion: getDataVersion() });
  }
  // Wait for a change or timeout after 30s
  const version = await Promise.race([
    new Promise<number>((resolve) => { addPollWaiter(resolve); }),
    new Promise<number>((resolve) => { setTimeout(() => resolve(getChangeVersion()), 30000); }),
  ]);
  return c.json({ version, dataVersion: getDataVersion() });
});

// --- Stats ---

dashboardRoutes.get('/stats', async (c) => {
  const stats = await getTicketStats();
  return c.json(stats);
});

// HS-8511 — per-view ticket counts for the sidebar badges.
dashboardRoutes.get('/sidebar-counts', async (c) => {
  return c.json({ counts: await getSidebarCounts() });
});

dashboardRoutes.get('/dashboard', async (c) => {
  const days = Math.max(1, Math.min(365, parseInt(c.req.query('days') ?? '30', 10) || 30));
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

dashboardRoutes.get('/global-config', (c) => {
  return c.json(readGlobalConfig());
});

dashboardRoutes.patch('/global-config', async (c) => {
  const raw: unknown = await c.req.json();
  const parsed = parseBody(GlobalConfigSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const merged = writeGlobalConfig(parsed.data);
  return c.json(merged);
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

// HS-8786 — a GUI-launched macOS app gets the minimal launchd PATH
// (`/usr/bin:/bin:/usr/sbin:/sbin`), so a bare `which glassbox` / `spawn('glassbox')`
// fails even though the CLI is installed in `/usr/local/bin` (Homebrew/local).
// We (a) search an AUGMENTED PATH + known install locations, (b) spawn the
// resolved ABSOLUTE path so launch doesn't depend on PATH at all, and (c) do NOT
// cache a negative result forever (so installing Glassbox after Hot Sheet started
// is picked up without a restart).
//
// HS-8801 — `process.env.PATH` here is ALREADY the user's real login-shell PATH:
// `enrichProcessPath()` (`src/enrich-path.ts`) merges `$SHELL -ilc 'printf %s
// "$PATH"'` into it at startup (before any route runs), so nvm/asdf/volta/custom-
// prefix `glassbox` installs are already discoverable. `extraSearchDirs()` (the
// shared static list, formerly a duplicate `glassboxBinDirs()` here) stays as the
// fallback for when the login-shell probe failed (Windows, no `$SHELL`, timeout)
// or for dirs the shell omits.

/** PATH augmented with the common GUI-PATH-missing install dirs, so the resolved
 *  `glassbox` (and any children it spawns) can find its toolchain. */
function augmentedPath(): string {
  return [process.env.PATH ?? '', ...extraSearchDirs()].filter(p => p !== '').join(':');
}

/**
 * Pure resolution logic (HS-8786) — injectable deps so it's unit-testable without
 * touching the real filesystem / `child_process`. Tries `which` (run under the
 * augmented PATH) first, then known install locations; returns the absolute path
 * or null. Exported for testing.
 */
export interface GlassboxResolveDeps {
  /** Result of `which glassbox` under the augmented PATH, or null if it failed.
   *  A non-empty result is trusted (which only returns existing executables). */
  which: () => string | null;
  fileExists: (p: string) => boolean;
  binDirs: string[];
}
export function resolveGlassboxBinWith(deps: GlassboxResolveDeps): string | null {
  const fromWhich = deps.which();
  if (fromWhich !== null && fromWhich !== '') return fromWhich;
  const candidates = [
    ...deps.binDirs.map(d => join(d, 'glassbox')),
    '/Applications/Glassbox.app/Contents/Resources/resources/glassbox',
  ];
  for (const p of candidates) if (deps.fileExists(p)) return p;
  return null;
}

/** Resolve the `glassbox` CLI to an absolute path, or null when not installed,
 *  wiring the real `which` (under the augmented PATH) + `existsSync`. */
async function resolveGlassboxBin(): Promise<string | null> {
  const { execFileSync } = await import('child_process');
  const which = (): string | null => {
    try {
      return execFileSync('which', ['glassbox'], {
        env: { ...process.env, PATH: augmentedPath() },
        encoding: 'utf-8',
      }).trim();
    } catch {
      return null;
    }
  };
  return resolveGlassboxBinWith({ which, fileExists: existsSync, binDirs: extraSearchDirs() });
}

dashboardRoutes.get('/glassbox/status', async (c) => {
  // Re-resolve each call (cheap) rather than caching — HS-8786: the old
  // cache-forever meant a PATH/install fix needed a server restart to take.
  return c.json({ available: (await resolveGlassboxBin()) !== null });
});

dashboardRoutes.post('/glassbox/launch', async (c) => {
  const bin = await resolveGlassboxBin();
  if (bin === null) return c.json({ error: 'Glassbox CLI not found. Install it (e.g. in /usr/local/bin) and try again.' }, 404);
  const { spawn } = await import('child_process');
  const path = await import('path');
  // Use the active project's root directory (parent of .hotsheet/), not
  // process.cwd() which is always the server's startup directory.
  const projectRoot = path.dirname(c.get('dataDir'));
  try {
    const child = spawn(bin, [], {
      cwd: projectRoot,
      detached: true,
      stdio: 'ignore',
      // Give the child the augmented PATH so its own toolchain lookups succeed.
      env: { ...process.env, PATH: augmentedPath() },
    });
    // The spawn is detached; surface an async spawn failure (e.g. EACCES) in the
    // server log rather than swallowing it silently.
    child.on('error', (err) => { console.error('[glassbox] launch failed:', err); });
    child.unref();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'spawn failed';
    return c.json({ error: `Could not launch Glassbox: ${message}` }, 500);
  }
  return c.json({ ok: true });
});

/**
 * HS-8472 — map a validated Glassbox review request to the `glassbox` CLI args
 * (`--commit <sha>` / `--range <from>..<to>`). Returns null when a sha / ref
 * fails its safety pattern, so a malformed value can't reach the spawn as an
 * unexpected git flag (the args are passed array-style — no shell — but a ref
 * like `--upload-pack=…` could still be read as a flag by `git diff`). Pure +
 * exported for testing.
 */
export function buildGlassboxReviewArgs(req: GlassboxReviewReq): string[] | null {
  // A ref starts with a word char (never `-`) and uses only ref-safe chars.
  const SAFE_REF = /^[\w][\w./-]*$/;
  if (req.mode === 'commit') {
    if (!/^[0-9a-fA-F]{7,40}$/.test(req.sha)) return null;
    return ['--commit', req.sha];
  }
  if (!SAFE_REF.test(req.from) || !SAFE_REF.test(req.to)) return null;
  return ['--range', `${req.from}..${req.to}`];
}

// HS-8472 — open Glassbox focused on a specific pending commit or the whole
// pending range, launched from the git-status popover.
dashboardRoutes.post('/glassbox/review', async (c) => {
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = GlassboxReviewReqSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid request body' }, 400);
  const args = buildGlassboxReviewArgs(parsed.data);
  if (args === null) return c.json({ error: 'Invalid commit / ref' }, 400);

  const bin = await resolveGlassboxBin();
  if (bin === null) return c.json({ error: 'Glassbox CLI not found. Install it (e.g. in /usr/local/bin) and try again.' }, 404);
  const { spawn } = await import('child_process');
  const path = await import('path');
  const projectRoot = path.dirname(c.get('dataDir'));
  try {
    const child = spawn(bin, args, {
      cwd: projectRoot,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PATH: augmentedPath() },
    });
    child.on('error', (err) => { console.error('[glassbox] review launch failed:', err); });
    child.unref();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'spawn failed';
    return c.json({ error: `Could not launch Glassbox: ${message}` }, 500);
  }
  return c.json({ ok: true });
});

// --- Gitignore ---

dashboardRoutes.get('/gitignore/status', (c) => {
  const cwd = process.cwd();
  if (!isGitRepo(cwd)) return c.json({ inGitRepo: false, ignored: false });
  return c.json({ inGitRepo: true, ignored: isHotsheetGitignored(cwd) });
});

dashboardRoutes.post('/gitignore/add', (c) => {
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
