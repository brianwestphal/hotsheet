import type { Context } from 'hono';
import { Hono } from 'hono';

import { DEFAULT_TERMINAL_ID, listTerminalConfigs, type TerminalConfig } from '../terminals/config.js';
import {
  clearBellPending,
  destroyTerminal,
  getBellPending,
  getTerminalStatus,
  killTerminal,
  listProjectTerminalIds,
  restartTerminal,
} from '../terminals/registry.js';
import type { AppEnv } from '../types.js';
import { notifyBellWaiters } from './notify.js';

export const terminalRoutes = new Hono<AppEnv>();

/** Pick a terminal id from the JSON body / query string; default to the main terminal. */
async function readTerminalId(c: Context<AppEnv>): Promise<string> {
  const query = c.req.query('terminalId');
  if (typeof query === 'string' && query !== '') return query;
  try {
    const body = await c.req.json<{ terminalId?: string } | undefined>();
    if (body && typeof body.terminalId === 'string' && body.terminalId !== '') return body.terminalId;
  } catch { /* empty body */ }
  return DEFAULT_TERMINAL_ID;
}

/**
 * Cache for dynamic (ad-hoc) terminal configs that aren't persisted to
 * settings.json. Keyed by `secret::terminalId`. This is consulted when the
 * websocket/registry needs to resolve a command for a dynamic terminal.
 */
const dynamicConfigs = new Map<string, TerminalConfig>();

export function getDynamicTerminalConfig(secret: string, terminalId: string): TerminalConfig | null {
  return dynamicConfigs.get(`${secret}::${terminalId}`) ?? null;
}

/** GET /api/terminal/list — list terminal ids/configs the client can attach to. */
terminalRoutes.get('/list', (c) => {
  const dataDir = c.get('dataDir');
  const secret = c.get('projectSecret');
  const configured = listTerminalConfigs(dataDir);
  const configuredIds = new Set(configured.map(c => c.id));
  const dynamic: TerminalConfig[] = [];
  const seen = new Set<string>();

  // Include every dynamic config we know about for this project — even if its
  // PTY hasn't spawned yet. POST /api/terminal/create registers the config but
  // the registry only learns about it on first WebSocket attach. Without this
  // pass, a freshly-created dynamic terminal would not appear in /list and the
  // client could not render its tab (HS-6341).
  const prefix = `${secret}::`;
  for (const [key, config] of dynamicConfigs.entries()) {
    if (!key.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    if (configuredIds.has(id) || seen.has(id)) continue;
    dynamic.push(config);
    seen.add(id);
  }

  // Defense in depth: surface any runtime-known dynamic ids whose config has
  // somehow been lost (e.g. server restart with a stale registry entry).
  for (const id of listProjectTerminalIds(secret)) {
    if (configuredIds.has(id) || seen.has(id)) continue;
    const dyn = dynamicConfigs.get(`${secret}::${id}`);
    if (dyn) { dynamic.push(dyn); seen.add(id); }
  }

  // HS-6603 §24.3.1 — annotate each entry with the current server-side
  // bellPending flag so the client can seed its in-drawer indicators on
  // initial render / project switch without waiting for a long-poll tick.
  const withBell = <T extends { id: string }>(items: T[]): (T & { bellPending: boolean })[] =>
    items.map(item => ({ ...item, bellPending: getBellPending(secret, item.id) }));

  return c.json({ configured: withBell(configured), dynamic: withBell(dynamic) });
});

/**
 * POST /api/terminal/clear-bell — drop the server-side bell-pending flag for
 * a terminal (HS-6603 §24.3.2). Body: `{ terminalId: string }`. Returns
 * `{ ok: true }` regardless of whether the flag was set; only bumps the
 * bellVersion counter when there was an actual flip so idle pollers don't
 * wake up for nothing.
 */
terminalRoutes.post('/clear-bell', async (c) => {
  const secret = c.get('projectSecret');
  const terminalId = await readTerminalId(c);
  const flipped = clearBellPending(secret, terminalId);
  if (flipped) notifyBellWaiters();
  return c.json({ ok: true });
});

/** GET /api/terminal/status — cheap status lookup, no PTY spawn. */
terminalRoutes.get('/status', (c) => {
  const dataDir = c.get('dataDir');
  const secret = c.get('projectSecret');
  const terminalId = c.req.query('terminalId') ?? DEFAULT_TERMINAL_ID;
  const status = getTerminalStatus(secret, dataDir, terminalId);
  return c.json(status);
});

/** POST /api/terminal/restart — kill the current PTY and spawn a fresh one. */
terminalRoutes.post('/restart', async (c) => {
  const dataDir = c.get('dataDir');
  const secret = c.get('projectSecret');
  const terminalId = await readTerminalId(c);
  restartTerminal(secret, dataDir, terminalId);
  return c.json({ ok: true });
});

/**
 * POST /api/terminal/kill — kill the current PTY without restart. Body
 * `{ signal?, terminalId? }`. Default is SIGHUP because interactive shells
 * (zsh/bash/fish) ignore SIGTERM but exit cleanly on hang-up (HS-6471).
 */
terminalRoutes.post('/kill', async (c) => {
  const secret = c.get('projectSecret');
  let signal: string = 'SIGHUP';
  let terminalId: string = c.req.query('terminalId') ?? DEFAULT_TERMINAL_ID;
  try {
    const body = await c.req.json<{ signal?: string; terminalId?: string } | undefined>();
    if (body && typeof body.signal === 'string' && body.signal !== '') signal = body.signal;
    if (body && typeof body.terminalId === 'string' && body.terminalId !== '') terminalId = body.terminalId;
  } catch { /* empty body is fine */ }
  killTerminal(secret, signal, terminalId);
  return c.json({ ok: true });
});

/**
 * POST /api/terminal/create — register a dynamic (ad-hoc) terminal config and
 * return its id. The PTY spawns lazily on first WebSocket attach.
 *
 * Body: `{ name?, command?, cwd? }`. When command is omitted, the user's default
 * shell is launched (Windows: `%COMSPEC%`, otherwise `$SHELL` — resolved at spawn).
 */
terminalRoutes.post('/create', async (c) => {
  const secret = c.get('projectSecret');
  const body = await c.req.json<{ name?: string; command?: string; cwd?: string } | undefined>().catch(() => undefined);
  const id = `dyn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const command = typeof body?.command === 'string' && body.command !== ''
    ? body.command
    : defaultShellCommand();
  // Always carry a friendly name so the drawer tab has a visible label even
  // when the client renders the response before any websocket attach.
  const name = typeof body?.name === 'string' && body.name !== ''
    ? body.name
    : friendlyShellName(command);
  const config: TerminalConfig = { id, command, name };
  if (typeof body?.cwd === 'string' && body.cwd !== '') config.cwd = body.cwd;
  dynamicConfigs.set(`${secret}::${id}`, config);
  return c.json({ config });
});

/** POST /api/terminal/destroy — fully remove a session, including its dynamic config. */
terminalRoutes.post('/destroy', async (c) => {
  const secret = c.get('projectSecret');
  const terminalId = await readTerminalId(c);
  destroyTerminal(secret, terminalId);
  dynamicConfigs.delete(`${secret}::${terminalId}`);
  return c.json({ ok: true });
});

function defaultShellCommand(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe';
  return process.env.SHELL ?? '/bin/sh';
}

/** Capitalize the basename of a shell path/command for use as a tab label. */
function friendlyShellName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? '';
  if (first === '') return 'Shell';
  // Strip directory prefix and Windows .exe extension.
  const base = first.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
  if (base === '') return 'Shell';
  return base.charAt(0).toUpperCase() + base.slice(1);
}
