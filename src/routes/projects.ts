import { existsSync } from 'fs';
import { Hono } from 'hono';
import { resolve } from 'path';

import { openInFileManager } from '../open-in-file-manager.js';
import { addToProjectList, removeFromProjectList, reorderProjectList } from '../project-list.js';
import { getAllProjects, getProjectBySecret, registerProject, reorderProjects, unregisterProject } from '../projects.js';
import type { AppEnv } from '../types.js';
import { notifyChange } from './notify.js';
import { parseBody, RegisterProjectSchema, ReorderProjectsSchema } from './validation.js';

export const projectRoutes = new Hono<AppEnv>();

/** GET /api/projects — list all registered projects */
projectRoutes.get('/', async (c) => {
  const projects = getAllProjects();
  const result = await Promise.all(projects.map(async (p) => {
    let ticketCount = 0;
    try {
      const res = await p.db.query<{ count: string }>(`SELECT COUNT(*) as count FROM tickets WHERE status != 'deleted'`);
      ticketCount = parseInt(res.rows[0]?.count ?? '0', 10);
    } catch { /* schema might not exist yet */ }
    return {
      name: p.name,
      dataDir: p.dataDir,
      secret: p.secret,
      ticketCount,
    };
  }));
  return c.json(result);
});

/** POST /api/projects/register — register a new project by dataDir path */
projectRoutes.post('/register', async (c) => {
  const raw: unknown = await c.req.json();
  const parsed = parseBody(RegisterProjectSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);

  try {
    // Use a fixed port — the server is already running, so we pass 0 and the
    // project will discover the port from settings.json later.
    // Actually, we need the real port. Read it from the first project's settings.
    const existing = getAllProjects();
    let port = 4174;
    if (existing.length > 0) {
      // All projects share the same server port
      const { readFileSettings } = await import('../file-settings.js');
      const settings = readFileSettings(existing[0].dataDir);
      port = settings.port ?? 4174;
    }

    const ctx = await registerProject(parsed.data.dataDir, port);
    addToProjectList(ctx.dataDir);
    // If channel is globally enabled, write .mcp.json for the new project
    const { readGlobalConfig } = await import('../global-config.js');
    if (readGlobalConfig().channelEnabled === true) {
      const { registerChannel } = await import('../channel-config.js');
      registerChannel(ctx.dataDir);
    }
    notifyChange(); // Wake long-poll so UI detects the new project
    return c.json({
      name: ctx.name,
      dataDir: ctx.dataDir,
      secret: ctx.secret,
    }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Registration failed';
    return c.json({ error: msg }, 500);
  }
});

/** DELETE /api/projects/:secret — unregister a project */
projectRoutes.delete('/:secret', (c) => {
  const secret = c.req.param('secret');
  const project = getProjectBySecret(secret);
  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  // Don't allow unregistering the last project
  const all = getAllProjects();
  if (all.length <= 1) {
    return c.json({ error: 'Cannot unregister the only project' }, 400);
  }

  removeFromProjectList(project.dataDir);
  unregisterProject(secret);
  notifyChange();
  return c.json({ ok: true });
});

/** GET /api/projects/channel-status — alive status for all projects (for tab dots) */
projectRoutes.get('/channel-status', async (c) => {
  const { isChannelAlive } = await import('../channel-config.js');
  const { readGlobalConfig } = await import('../global-config.js');
  const globalConfig = readGlobalConfig();
  const enabled = globalConfig.channelEnabled === true;
  if (!enabled) return c.json({ enabled: false, projects: {} });

  const projects = getAllProjects();
  const statuses: Record<string, boolean> = {};
  await Promise.all(projects.map(async (p) => {
    statuses[p.secret] = await isChannelAlive(p.dataDir);
  }));
  return c.json({ enabled: true, projects: statuses });
});

/** GET /api/projects/permissions — check for pending permissions across all projects (long-poll, 3s timeout) */
projectRoutes.get('/permissions', async (c) => {
  const { getChannelPort } = await import('../channel-config.js');
  const { readGlobalConfig } = await import('../global-config.js');
  const { addPermissionWaiter, getPermissionVersion } = await import('./notify.js');
  const globalConfig = readGlobalConfig();
  if (globalConfig.channelEnabled !== true) return c.json({ permissions: {}, v: 0 });

  const clientVersion = parseInt(c.req.query('v') ?? '0', 10) || 0;

  async function checkAll(): Promise<Record<string, { request_id: string; tool_name: string; description: string; input_preview?: string } | null>> {
    const projects = getAllProjects();
    const result: Record<string, { request_id: string; tool_name: string; description: string; input_preview?: string } | null> = {};
    await Promise.all(projects.map(async (p) => {
      const port = getChannelPort(p.dataDir);
      if (port === null) { result[p.secret] = null; return; }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/permission`);
        const data = await res.json() as { pending: { request_id: string; tool_name: string; description: string; input_preview?: string } | null };
        result[p.secret] = data.pending;
      } catch {
        result[p.secret] = null;
      }
    }));
    return result;
  }

  // If the permission version changed since the client last checked, return immediately
  // (this closes the race condition where a notify fires during checkAll)
  const versionBefore = getPermissionVersion();
  if (versionBefore > clientVersion) {
    return c.json({ permissions: await checkAll(), v: versionBefore });
  }

  // Check immediately — if any project has a pending permission, return right away
  const immediate = await checkAll();
  const versionAfter = getPermissionVersion();
  if (Object.values(immediate).some(v => v !== null) || versionAfter > versionBefore) {
    return c.json({ permissions: immediate, v: versionAfter });
  }

  // Wait for a permission notification or 3s timeout.
  // Short timeout because the channel server's HTTP notify to wake this
  // long-poll is unreliable (auth issues, separate process). The version
  // counter prevents the client from hot-looping when nothing changed.
  await Promise.race([
    new Promise<void>((resolve) => { addPermissionWaiter(resolve); }),
    new Promise<void>((resolve) => { setTimeout(resolve, 3000); }),
  ]);

  return c.json({ permissions: await checkAll(), v: getPermissionVersion() });
});

/** POST /api/projects/:secret/reveal — open the project folder in OS file manager */
projectRoutes.post('/:secret/reveal', async (c) => {
  const secret = c.req.param('secret');
  const project = getProjectBySecret(secret);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  // Project root is the parent of the .hotsheet data dir
  const projectRoot = resolve(project.dataDir, '..');
  if (!existsSync(projectRoot)) return c.json({ error: 'Folder not found on disk' }, 404);

  await openInFileManager(projectRoot);
  return c.json({ ok: true });
});

/** POST /api/projects/reorder — reorder the project list */
projectRoutes.post('/reorder', async (c) => {
  const raw: unknown = await c.req.json();
  const parsed = parseBody(ReorderProjectsSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);

  const dataDirs = reorderProjects(parsed.data.secrets);
  reorderProjectList(dataDirs);
  return c.json({ ok: true });
});
