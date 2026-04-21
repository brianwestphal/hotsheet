import type { Context } from 'hono';
import { Hono } from 'hono';

import { DEFAULT_TERMINAL_ID, listTerminalConfigs, type TerminalConfig } from '../terminals/config.js';
import {
  destroyTerminal,
  getTerminalStatus,
  killTerminal,
  listProjectTerminalIds,
  restartTerminal,
} from '../terminals/registry.js';
import type { AppEnv } from '../types.js';

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
  const runtimeIds = listProjectTerminalIds(secret);
  // Dynamic: any runtime-known id that isn't in the configured list.
  const configuredIds = new Set(configured.map(c => c.id));
  const dynamic: TerminalConfig[] = [];
  for (const id of runtimeIds) {
    if (configuredIds.has(id)) continue;
    const dyn = dynamicConfigs.get(`${secret}::${id}`);
    if (dyn) dynamic.push(dyn);
  }
  return c.json({ configured, dynamic });
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

/** POST /api/terminal/kill — kill the current PTY without restart. Body `{ signal?, terminalId? }`. */
terminalRoutes.post('/kill', async (c) => {
  const secret = c.get('projectSecret');
  let signal: string = 'SIGTERM';
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
  const config: TerminalConfig = { id, command };
  if (typeof body?.name === 'string' && body.name !== '') config.name = body.name;
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
