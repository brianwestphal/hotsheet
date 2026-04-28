import { existsSync, readFileSync } from 'fs';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { homedir } from 'os';

import { readFileSettings } from '../file-settings.js';
import { DEFAULT_TERMINAL_ID, listTerminalConfigs, type TerminalConfig } from '../terminals/config.js';
import {
  DEFAULT_EXEMPT_PROCESSES,
  inspectForegroundProcess,
} from '../terminals/processInspect.js';
import {
  clearBellPending,
  destroyTerminal,
  ensureSpawned,
  getBellPending,
  getCurrentCwd,
  getLastOutputAtMs,
  getLastSpinnerAtMs,
  getNotificationMessage,
  getTerminalPid,
  getTerminalScrollbackPreview,
  getTerminalStatus,
  killTerminal,
  listProjectTerminalIds,
  restartTerminal,
  type TerminalState,
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

/**
 * Return every dynamic config the server knows about for a project. Used by
 * the §37 quit-confirm aggregator to label dynamic-terminal entries with the
 * user's friendly name (HS-7789) — without this, the dialog falls back to
 * the raw `dyn-…` id because the persisted `listTerminalConfigs` doesn't
 * contain dynamic terminals.
 */
export function listDynamicTerminalConfigs(secret: string): TerminalConfig[] {
  const prefix = `${secret}::`;
  const out: TerminalConfig[] = [];
  for (const [key, config] of dynamicConfigs.entries()) {
    if (key.startsWith(prefix)) out.push(config);
  }
  return out;
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
  // HS-6834 §25.5 — also include `state` so the terminal dashboard knows which
  // entries it can safely open a WebSocket against (only `alive`) and which
  // should render as placeholders (`not_spawned` / `exited`, HS-6838). This
  // avoids accidentally spawning lazy-mode terminals when the dashboard opens.
  // HS-6838 — exitCode accompanies `state === 'exited'` so the placeholder
  // tile can display `Exited (code N)` without needing a second round-trip.
  // HS-7264 — notificationMessage is set when the PTY pushed an OSC 9 desktop
  // notification (`\x1b]9;<message>\x07`); the client surfaces this as a toast.
  // HS-7278 — currentCwd is set when the PTY pushed an OSC 7 CWD
  // (`\x1b]7;file://host/path\x07`); the dashboard renders it as a tile badge
  // so the user can tell where each shell is without enlarging the tile.
  // HS-6702 — `lastSpinnerAtMs` + `lastOutputAtMs` let the channel-UI
  // distinguish channel-busy-but-Claude-idle from channel-busy-and-Claude-
  // working. See `containsClaudeSpinner` in `src/terminals/claudeSpinner.ts`.
  const annotate = <T extends { id: string }>(items: T[]): (T & { bellPending: boolean; notificationMessage: string | null; currentCwd: string | null; state: TerminalState; exitCode: number | null; lastSpinnerAtMs: number | null; lastOutputAtMs: number | null })[] =>
    items.map(item => {
      const status = getTerminalStatus(secret, dataDir, item.id);
      return {
        ...item,
        bellPending: getBellPending(secret, item.id),
        notificationMessage: getNotificationMessage(secret, item.id),
        currentCwd: getCurrentCwd(secret, item.id),
        state: status.state,
        exitCode: status.exitCode,
        lastSpinnerAtMs: getLastSpinnerAtMs(secret, item.id),
        lastOutputAtMs: getLastOutputAtMs(secret, item.id),
      };
    });

  // HS-7276 — the terminal CWD chip (§29.3) tildifies paths under $HOME. The
  // client can't read its own env; push the resolved home dir alongside the
  // terminal list so the chip can render `~/x` instead of `/Users/me/x` on
  // the first /list tick. `os.homedir()` returns the correct value in both
  // browser-mode (node running directly) and Tauri sidecar mode (Tauri spawns
  // node with the user's env inherited).
  return c.json({ configured: annotate(configured), dynamic: annotate(dynamic), home: homedir() });
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

/**
 * POST /api/terminal/open-cwd — open a path in the OS file manager. Body
 * `{ path: string }`. Used by the OSC 7 CWD chip on the terminal toolbar
 * (HS-7262, §29). The server validates the path exists and is a directory
 * before dispatching to `openInFileManager`, so a stale OSC 7 payload
 * (e.g. shell reported a CWD that was then `rmdir`'d) returns a 404 instead
 * of launching a confused Finder window.
 *
 * The path comes from the client's local record of the most recent OSC 7
 * push, which the shell wrote to stdout — no new privilege is granted here
 * vs. the user running `open <path>` directly in that shell.
 */
terminalRoutes.post('/open-cwd', async (c) => {
  const body = await c.req.json<{ path?: string } | undefined>().catch(() => undefined);
  const path = body?.path;
  if (typeof path !== 'string' || path === '') {
    return c.json({ error: 'missing path' }, 400);
  }
  const { existsSync, statSync } = await import('fs');
  if (!existsSync(path)) return c.json({ error: 'path not found on disk' }, 404);
  try {
    if (!statSync(path).isDirectory()) return c.json({ error: 'path is not a directory' }, 400);
  } catch {
    return c.json({ error: 'path unreadable' }, 404);
  }
  const { openInFileManager } = await import('../open-in-file-manager.js');
  await openInFileManager(path);
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

/**
 * GET /api/terminal/scrollback-preview?terminalId=<id>&maxLines=<n> — HS-7969.
 * Returns a plain-text preview of the last N rendered lines of the terminal's
 * scrollback (ANSI-stripped) for the §37 quit-confirm dialog's expand-row
 * preview. Empty string when the session is unknown or hasn't emitted any
 * output yet. Capped at 200 lines so a malicious / chatty client can't
 * exhaust the response payload.
 */
terminalRoutes.get('/scrollback-preview', (c) => {
  const secret = c.get('projectSecret');
  const terminalId = c.req.query('terminalId') ?? '';
  if (terminalId === '') return c.json({ error: 'missing_terminal_id' }, 400);
  const requested = parseInt(c.req.query('maxLines') ?? '30', 10);
  const maxLines = Math.max(1, Math.min(200, Number.isFinite(requested) ? requested : 30));
  const text = getTerminalScrollbackPreview(secret, terminalId, maxLines);
  return c.json({ text, maxLines });
});

/**
 * GET /api/terminal/foreground-process?terminalId=<id> — HS-7596 / §37.6.
 * Walks the OS process tree from the PTY's pid and returns the foreground
 * child basename + isShell + isExempt flags. Used by the §37 quit-confirm
 * flow to decide whether the prompt should fire for this terminal. Falls
 * back to the safe-default-prompt info `{ command: '?', isShell: false,
 * isExempt: false }` on any lookup error so the prompt fires conservatively.
 */
terminalRoutes.get('/foreground-process', async (c) => {
  const dataDir = c.get('dataDir');
  const secret = c.get('projectSecret');
  const terminalId = c.req.query('terminalId') ?? DEFAULT_TERMINAL_ID;
  const pid = getTerminalPid(secret, terminalId);
  if (pid === null) {
    return c.json({
      command: '?', isShell: false, isExempt: false, error: 'no live PTY',
    });
  }
  const settings = readFileSettings(dataDir);
  const exemptRaw = settings.quit_confirm_exempt_processes;
  const exempt = Array.isArray(exemptRaw)
    ? exemptRaw.filter((s): s is string => typeof s === 'string' && s !== '')
    : DEFAULT_EXEMPT_PROCESSES;
  const info = await inspectForegroundProcess(pid, exempt);
  return c.json(info);
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
 * return its id. By default the PTY spawns lazily on first WebSocket attach
 * (the drawer's `+` button relies on that — it selects the new tab
 * immediately, which opens a WS and triggers the spawn).
 *
 * Body: `{ name?, command?, cwd?, spawn? }`. When command is omitted, the
 * user's default shell is launched (Windows: `%COMSPEC%`, otherwise `$SHELL`
 * — resolved at spawn).
 *
 * HS-7228: pass `spawn: true` to start the PTY immediately, without waiting
 * for a WebSocket attach. Used by the dashboard's per-project `+` button
 * (§25.4) so the freshly-created tile renders as `alive` in the grid rather
 * than as a cold `not_spawned` placeholder — the dashboard's mental model is
 * "the + button adds a running terminal", matching the drawer's flow.
 */
terminalRoutes.post('/create', async (c) => {
  const dataDir = c.get('dataDir');
  const secret = c.get('projectSecret');
  const body = await c.req.json<{ name?: string; command?: string; cwd?: string; spawn?: boolean } | undefined>().catch(() => undefined);
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
  if (body?.spawn === true) {
    try {
      ensureSpawned(secret, dataDir, id, config);
    } catch (err) {
      // Mirror eagerSpawnTerminals' policy: log but don't fail the request.
      // The config is still registered, so a subsequent WS attach can retry.
      console.warn(`[terminals] Eager-spawn on /create failed for '${id}': ${String(err)}`);
    }
  }
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

/**
 * GET /api/terminal/command-suggestions — HS-7791. Curated list of common
 * commands the Edit Terminal dialog uses to populate a combobox so users
 * don't have to remember `{{claudeCommand}}` syntax or type their shell path
 * by hand. Always includes the `{{claudeCommand}}` sentinel first; on Unix
 * also surfaces `process.env.SHELL` (the user's default login shell) plus
 * any well-known shells found via `/etc/shells`; on Windows surfaces COMSPEC,
 * `pwsh.exe`, and `powershell.exe` when they exist.
 *
 * Read-only and per-instance — the response shape is `{ suggestions: string[] }`
 * with the entries pre-deduplicated and ordered by likelihood-to-be-used.
 */
terminalRoutes.get('/command-suggestions', (c) => {
  return c.json({ suggestions: collectCommandSuggestions() });
});

function defaultShellCommand(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe';
  return process.env.SHELL ?? '/bin/sh';
}

/**
 * Build the suggestion list for the Edit Terminal command combobox (HS-7791).
 * Order: `{{claudeCommand}}` sentinel → user's default login shell → any
 * additional shells discovered on the system (via `/etc/shells` on Unix or
 * well-known paths on Windows). Duplicates removed; entries returned as-is
 * (full path included) so the user sees what would actually exec.
 */
export function collectCommandSuggestions(): string[] {
  const out: string[] = ['{{claudeCommand}}'];
  const seen = new Set<string>(out);

  const add = (entry: string | undefined | null): void => {
    if (typeof entry !== 'string') return;
    const trimmed = entry.trim();
    if (trimmed === '') return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };

  const userShell = defaultShellCommand();
  add(userShell);

  if (process.platform === 'win32') {
    // Probe well-known PowerShell + cmd locations. We can't rely on `which`
    // on Windows so check absolute paths directly.
    const candidates = [
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Windows\\System32\\cmd.exe',
    ];
    for (const path of candidates) {
      try { if (existsSync(path)) add(path); } catch { /* probe is best-effort */ }
    }
  } else {
    // Unix: read /etc/shells. Lines starting with `#` are comments; everything
    // else is a shell path. Filter to entries that exist on disk so we don't
    // surface stale registrations.
    try {
      if (existsSync('/etc/shells')) {
        const lines = readFileSync('/etc/shells', 'utf8').split(/\r?\n/);
        for (const raw of lines) {
          const line = raw.trim();
          if (line === '' || line.startsWith('#')) continue;
          if (existsSync(line)) add(line);
        }
      }
    } catch { /* /etc/shells read is best-effort */ }
  }
  return out;
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
