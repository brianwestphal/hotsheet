import { existsSync } from 'fs';
import { Hono } from 'hono';
import { resolve } from 'path';

import { openInFileManager } from '../open-in-file-manager.js';
import { addToProjectList, readProjectList, removeFromProjectList, reorderProjectList } from '../project-list.js';
import { getAllProjects, getProjectBySecret, registerProject, reorderProjects, unregisterProject } from '../projects.js';
import type { AppEnv } from '../types.js';
import { notifyChange } from './notify.js';
import { parseBody, RegisterProjectSchema, ReorderProjectsSchema } from './validation.js';

export const projectRoutes = new Hono<AppEnv>();

/** GET /api/projects — list all registered projects (auto-prunes stale entries) */
projectRoutes.get('/', async (c) => {
  // Auto-prune in-memory projects whose data directories no longer exist
  const projects = getAllProjects();
  const stale = projects.filter(p => !existsSync(p.dataDir));
  for (const p of stale) {
    removeFromProjectList(p.dataDir);
    unregisterProject(p.secret);
  }

  // Also prune persisted entries not in memory (e.g. from crashed test processes)
  const persisted = readProjectList();
  const inMemoryDirs = new Set(getAllProjects().map(p => p.dataDir));
  for (const dir of persisted) {
    if (!inMemoryDirs.has(dir) && !existsSync(dir)) {
      removeFromProjectList(dir);
    }
  }

  const live = stale.length > 0 ? getAllProjects() : projects;
  const result = await Promise.all(live.map(async (p) => {
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

// GET /api/projects/bell-state — long-poll (3 s) aggregating the server-side
// bellPending flag across every registered project (HS-6603 §24.3.3). Mirrors
// /api/projects/permissions. Response shape is `{ bells: { [secret]: { anyTerminalPending, terminalIds } }, v }`.
projectRoutes.get('/bell-state', async (c) => {
  const { addBellWaiter, getBellVersion } = await import('./notify.js');
  const { listBellPendingForProject, listPendingPromptsForProject } = await import('../terminals/registry.js');

  const clientVersion = parseInt(c.req.query('v') ?? '0', 10) || 0;

  // HS-8034 Phase 2 — `pendingPrompts: { [terminalId]: MatchResult }` is
  // the server-side scanner's match-list per project. Only populated when
  // the auto-allow gate did NOT short-circuit (auto-allow leaves
  // pendingPrompt null so no overlay surfaces). The MatchResult shape is
  // JSON-serializable as-is, so we hand it through verbatim and let the
  // client decide how to render it (numbered / yesno / generic).
  function snapshot(): Record<
    string,
    {
      anyTerminalPending: boolean;
      terminalIds: string[];
      notifications: Record<string, string>;
      pendingPrompts: Record<string, unknown>;
    }
  > {
    const projects = getAllProjects();
    const result: Record<
      string,
      {
        anyTerminalPending: boolean;
        terminalIds: string[];
        notifications: Record<string, string>;
        pendingPrompts: Record<string, unknown>;
      }
    > = {};
    for (const p of projects) {
      const entries = listBellPendingForProject(p.secret);
      const terminalIds = entries.map(e => e.terminalId);
      // HS-7264 — piggyback the OSC 9 message onto the existing long-poll so
      // clients get the toast payload without a second round-trip. Only entries
      // whose message is non-null are emitted; the existing `terminalIds` list
      // still drives the bell glyph (every pending terminal shows up there,
      // with or without a notification message).
      const notifications: Record<string, string> = {};
      for (const e of entries) {
        if (e.message !== null) notifications[e.terminalId] = e.message;
      }
      // HS-8034 — every pending terminal-prompt match for this project,
      // keyed by terminalId so a multi-terminal project can surface all of
      // them. Empty object when no prompts pending.
      const pendingPrompts: Record<string, unknown> = {};
      for (const entry of listPendingPromptsForProject(p.secret)) {
        pendingPrompts[entry.terminalId] = entry.match;
      }
      result[p.secret] = {
        anyTerminalPending: terminalIds.length > 0,
        terminalIds,
        notifications,
        pendingPrompts,
      };
    }
    return result;
  }

  // Fast path — version already advanced past the client's cursor.
  const versionBefore = getBellVersion();
  if (versionBefore > clientVersion) {
    return c.json({ bells: snapshot(), v: versionBefore });
  }

  // Otherwise wait for a wake or 3s timeout (matches /api/projects/permissions).
  await Promise.race([
    new Promise<void>((resolve) => { addBellWaiter(resolve); }),
    new Promise<void>((resolve) => { setTimeout(resolve, 3000); }),
  ]);

  return c.json({ bells: snapshot(), v: getBellVersion() });
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

/**
 * GET /api/projects/quit-summary — HS-7596 / §37 quit-confirm aggregator.
 * Walks every registered project's alive PTYs in parallel, inspects each
 * one's foreground process via `ps`, and returns a list of entries grouped
 * by project. Each entry carries `{terminalId, label, foregroundCommand,
 * isShell, isExempt}` plus the project's `confirmMode` (`'always'` /
 * `'never'` / `'with-non-exempt-processes'`) so the client can apply
 * §37.5's per-project + cross-project decision logic and build the
 * confirmation dialog. The route does NOT decide whether to prompt; the
 * client owns that policy because it knows the user's interaction state
 * (e.g. whether the prompt is fired from ⌘Q vs `hotsheet --close`).
 *
 * Stale-instance cleanup intentionally bypasses this endpoint — that path
 * is programmatic and the user is already quitting through a new window.
 */
projectRoutes.get('/quit-summary', async (c) => {
  const { listAliveTerminalsAcrossProjects } = await import('../terminals/registry.js');
  const { listTerminalConfigs, DEFAULT_TERMINAL_ID } = await import('../terminals/config.js');
  const { listDynamicTerminalConfigs } = await import('./terminal.js');
  const { readFileSettings } = await import('../file-settings.js');
  const {
    DEFAULT_EXEMPT_PROCESSES,
    inspectForegroundProcess,
  } = await import('../terminals/processInspect.js');

  type SummaryEntry = {
    terminalId: string;
    label: string;
    foregroundCommand: string;
    isShell: boolean;
    isExempt: boolean;
    /** HS-8059 follow-up — per-terminal appearance override. Layered with
     *  the project-level `terminalDefault` on the client so the quit-
     *  confirm preview pane can paint its gutter to match the terminal's
     *  theme bg WITHOUT depending on `term.options.theme` being set
     *  asynchronously by another consumer. Identical shape to
     *  `TerminalConfig`'s appearance fields. */
    theme?: string;
    fontFamily?: string;
    fontSize?: number;
  };
  type ProjectSummary = {
    secret: string;
    name: string;
    confirmMode: 'always' | 'never' | 'with-non-exempt-processes';
    entries: SummaryEntry[];
    /** HS-8059 follow-up — project's `terminal_default` block from
     *  settings.json. The client layers this UNDER per-entry overrides
     *  to resolve the final appearance for the preview-pane gutter. */
    terminalDefault?: { theme?: string; fontFamily?: string; fontSize?: number };
  };

  const aliveByProject = new Map<string, Array<{ terminalId: string; rootPid: number }>>();
  for (const t of listAliveTerminalsAcrossProjects()) {
    const list = aliveByProject.get(t.secret);
    if (list === undefined) aliveByProject.set(t.secret, [{ terminalId: t.terminalId, rootPid: t.rootPid }]);
    else list.push({ terminalId: t.terminalId, rootPid: t.rootPid });
  }

  const projects = getAllProjects();
  const result: ProjectSummary[] = [];
  for (const project of projects) {
    const settings = readFileSettings(project.dataDir);
    const rawMode = settings.confirm_quit_with_running_terminals;
    const confirmMode: 'always' | 'never' | 'with-non-exempt-processes' =
      rawMode === 'always' || rawMode === 'never' ? rawMode : 'with-non-exempt-processes';
    const exemptRaw = settings.quit_confirm_exempt_processes;
    const exempt = Array.isArray(exemptRaw)
      ? exemptRaw.filter((s): s is string => typeof s === 'string' && s !== '')
      : DEFAULT_EXEMPT_PROCESSES;

    // Resolve labels via the configured-terminal list AND the in-memory
    // dynamic-terminal registry (HS-7789) so each entry shows the user's
    // chosen tab name (or the friendly fallback assigned at /create time) —
    // matches how the drawer / dashboard label tabs.
    const configured = listTerminalConfigs(project.dataDir);
    const dynamicConfigs = listDynamicTerminalConfigs(project.secret);
    const labelByTid = new Map<string, string>();
    // HS-8059 follow-up — also build a (terminalId → appearance-overrides)
    // map keyed off the same configured + dynamic lists. Per-entry
    // overrides ride along on the response so the client can resolve
    // appearance synchronously without waiting on another consumer to
    // apply it via `applyAppearanceToTerm`.
    const appearanceByTid = new Map<string, { theme?: string; fontFamily?: string; fontSize?: number }>();
    for (const cfg of [...configured, ...dynamicConfigs]) {
      const fallback = cfg.command.trim().split(/\s+/)[0]?.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '') ?? cfg.id;
      const label = (cfg.name !== undefined && cfg.name !== '')
        ? cfg.name
        : (fallback !== '' ? fallback : cfg.id);
      labelByTid.set(cfg.id, label);
      const appearance: { theme?: string; fontFamily?: string; fontSize?: number } = {};
      if (cfg.theme !== undefined) appearance.theme = cfg.theme;
      if (cfg.fontFamily !== undefined) appearance.fontFamily = cfg.fontFamily;
      if (cfg.fontSize !== undefined) appearance.fontSize = cfg.fontSize;
      if (Object.keys(appearance).length > 0) appearanceByTid.set(cfg.id, appearance);
    }

    const alive = aliveByProject.get(project.secret) ?? [];
    const entries: SummaryEntry[] = [];
    for (const t of alive) {
      const info = await inspectForegroundProcess(t.rootPid, exempt);
      const entry: SummaryEntry = {
        terminalId: t.terminalId,
        label: labelByTid.get(t.terminalId) ?? (t.terminalId === DEFAULT_TERMINAL_ID ? 'Default' : t.terminalId),
        foregroundCommand: info.command,
        isShell: info.isShell,
        isExempt: info.isExempt,
      };
      const ov = appearanceByTid.get(t.terminalId);
      if (ov !== undefined) {
        if (ov.theme !== undefined) entry.theme = ov.theme;
        if (ov.fontFamily !== undefined) entry.fontFamily = ov.fontFamily;
        if (ov.fontSize !== undefined) entry.fontSize = ov.fontSize;
      }
      entries.push(entry);
    }
    // HS-8059 follow-up — extract `terminal_default` so the client has the
    // project-default layer for resolveAppearance.
    const rawDefault = settings.terminal_default;
    const terminalDefault: { theme?: string; fontFamily?: string; fontSize?: number } | undefined =
      (rawDefault !== null && typeof rawDefault === 'object' && !Array.isArray(rawDefault))
        ? (() => {
            const obj = rawDefault as { theme?: unknown; fontFamily?: unknown; fontSize?: unknown };
            const out: { theme?: string; fontFamily?: string; fontSize?: number } = {};
            if (typeof obj.theme === 'string') out.theme = obj.theme;
            if (typeof obj.fontFamily === 'string') out.fontFamily = obj.fontFamily;
            if (typeof obj.fontSize === 'number' && Number.isFinite(obj.fontSize)) out.fontSize = obj.fontSize;
            return Object.keys(out).length > 0 ? out : undefined;
          })()
        : undefined;
    const projectSummary: ProjectSummary = { secret: project.secret, name: project.name, confirmMode, entries };
    if (terminalDefault !== undefined) projectSummary.terminalDefault = terminalDefault;
    result.push(projectSummary);
  }

  return c.json({ projects: result });
});
