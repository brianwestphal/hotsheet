import { Hono } from 'hono';

import { addLogEntry, updateLogEntry } from '../db/commandLog.js';
import { getSettings } from '../db/settings.js';
import type { AppEnv } from '../types.js';
import { addPermissionWaiter, notifyChange, notifyPermission } from './notify.js';
import { ChannelTriggerSchema, parseBody, PermissionRespondSchema } from './validation.js';

export const channelRoutes = new Hono<AppEnv>();

// Per-project done flags, keyed by project secret
const channelDoneFlags = new Map<string, boolean>();

// Track which permission request_ids we've already logged to avoid duplicates
const loggedPermissionRequests = new Map<string, number>(); // request_id -> log entry id

channelRoutes.get('/channel/claude-check', async (c) => {
  const { execFileSync } = await import('child_process');
  try {
    const version = execFileSync('claude', ['--version'], { timeout: 5000, encoding: 'utf-8' }).trim();
    // Version string like "Claude Code v2.1.85" or just "2.1.85"
    const match = version.match(/(\d+\.\d+\.\d+)/);
    const versionNum = match !== null ? match[1] : null;
    const parts = versionNum !== null ? versionNum.split('.').map(Number) : [];
    // Requires v2.1.80+
    const meetsMinimum = parts.length === 3 && (
      parts[0] > 2 || (parts[0] === 2 && parts[1] > 1) || (parts[0] === 2 && parts[1] === 1 && parts[2] >= 80)
    );
    return c.json({ installed: true, version: versionNum, meetsMinimum });
  } catch {
    return c.json({ installed: false, version: null, meetsMinimum: false });
  }
});

channelRoutes.get('/channel/status', async (c) => {
  const { isChannelAlive, getChannelPort } = await import('../channel-config.js');
  const { readGlobalConfig } = await import('../global-config.js');
  const dataDir = c.get('dataDir');
  // Channel enabled is a global setting; fall back to legacy per-project DB (read-only)
  const globalConfig = readGlobalConfig();
  let enabled: boolean;
  if (globalConfig.channelEnabled !== undefined) {
    enabled = globalConfig.channelEnabled;
  } else {
    const settings = await getSettings();
    enabled = settings.channel_enabled === 'true';
  }
  const port = getChannelPort(dataDir);
  const alive = enabled ? await isChannelAlive(dataDir) : false;
  // Consume the done flag for this project (read once, then clear)
  const projectSecret = c.get('projectSecret');
  const done = channelDoneFlags.get(projectSecret) === true;
  if (done) channelDoneFlags.delete(projectSecret);
  return c.json({ enabled, alive, port, done });
});

channelRoutes.post('/channel/trigger', async (c) => {
  const { triggerChannel } = await import('../channel-config.js');
  const dataDir = c.get('dataDir');
  const serverPort = parseInt(new URL(c.req.url).port || '4174', 10);
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = parseBody(ChannelTriggerSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  channelDoneFlags.delete(c.get('projectSecret')); // Reset done flag on new trigger
  loggedPermissionRequests.clear(); // Reset dedup set for new session
  const ok = await triggerChannel(dataDir, serverPort, parsed.data.message);
  const summary = parsed.data.message !== undefined && parsed.data.message !== '' ? parsed.data.message.slice(0, 200) : 'Worklist trigger';
  addLogEntry('trigger', 'outgoing', summary, parsed.data.message ?? '').catch(() => {});
  return c.json({ ok });
});

type PermissionResult = { pending: { request_id?: string; tool_name?: string; description?: string; input_preview?: string; tool_input?: unknown } | null };

/** Fetch permission from the channel server and log new requests. */
async function fetchPermission(dataDir: string): Promise<PermissionResult> {
  const { getChannelPort } = await import('../channel-config.js');
  const port = getChannelPort(dataDir);
  if (port === null) return { pending: null };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/permission`);
    const data = await res.json() as PermissionResult;
    if (data.pending !== null) {
      const reqId = data.pending.request_id ?? '';
      if (reqId !== '' && !loggedPermissionRequests.has(reqId)) {
        const toolName = data.pending.tool_name ?? 'unknown tool';
        const description = data.pending.description ?? '';
        const inputPreview = data.pending.input_preview ?? (
          data.pending.tool_input !== undefined ? JSON.stringify(data.pending.tool_input, null, 2).slice(0, 2000) : ''
        );
        const detail = (description !== '' ? description + '\n\n' : '') + inputPreview;
        addLogEntry('permission_request', 'incoming', `Permission: ${toolName}`, detail)
          .then(entry => { loggedPermissionRequests.set(reqId, entry.id); })
          .catch(() => { loggedPermissionRequests.set(reqId, 0); });
      }
    }
    return data;
  } catch {
    return { pending: null };
  }
}

/** Long-poll: returns immediately if a permission is pending, otherwise waits up to 3s. */
channelRoutes.get('/channel/permission', async (c) => {
  const dataDir = c.get('dataDir');
  const immediate = await fetchPermission(dataDir);
  if (immediate.pending !== null) return c.json(immediate);

  // Wait for a permission notification or 3s timeout
  await Promise.race([
    new Promise<void>((resolve) => { addPermissionWaiter(resolve); }),
    new Promise<void>((resolve) => { setTimeout(resolve, 3000); }),
  ]);

  return c.json(await fetchPermission(dataDir));
});

channelRoutes.post('/channel/permission/respond', async (c) => {
  const { getChannelPort } = await import('../channel-config.js');
  const dataDir = c.get('dataDir');
  const port = getChannelPort(dataDir);
  if (port === null) return c.json({ error: 'Channel not available' }, 503);
  const raw: unknown = await c.req.json();
  const parsed = parseBody(PermissionRespondSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const action = parsed.data.behavior === 'allow' ? 'Allowed' : 'Denied';
  const toolName = parsed.data.tool_name ?? 'tool';
  // Update the existing permission_request entry with the response instead of creating a new one
  const logId = loggedPermissionRequests.get(parsed.data.request_id);
  if (logId !== undefined && logId > 0) {
    updateLogEntry(logId, { summary: `Permission: ${toolName} — ${action}` }).catch(() => {});
  } else {
    addLogEntry('permission_request', 'incoming', `Permission: ${toolName} — ${action}`, JSON.stringify(parsed.data)).catch(() => {});
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/permission/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed.data),
    });
    return c.json(await res.json());
  } catch {
    return c.json({ error: 'Failed to reach channel server' }, 503);
  }
});

channelRoutes.post('/channel/permission/dismiss', async (c) => {
  const { getChannelPort } = await import('../channel-config.js');
  const dataDir = c.get('dataDir');
  const port = getChannelPort(dataDir);
  if (port === null) return c.json({ ok: true });
  try {
    await fetch(`http://127.0.0.1:${port}/permission/dismiss`, { method: 'POST' });
  } catch { /* ignore */ }
  return c.json({ ok: true });
});

channelRoutes.post('/channel/done', (_c) => {
  const secret = _c.get('projectSecret');
  if (secret) channelDoneFlags.set(secret, true);
  addLogEntry('done', 'incoming', 'Claude finished', '').catch(() => {});
  notifyChange(); // Triggers long-poll so client picks up the done state
  return _c.json({ ok: true });
});

channelRoutes.post('/channel/enable', async (c) => {
  const { registerChannel, registerChannelForAll } = await import('../channel-config.js');
  const { writeGlobalConfig } = await import('../global-config.js');
  const dataDir = c.get('dataDir');
  writeGlobalConfig({ channelEnabled: true });
  // Register .mcp.json and ensure skills for ALL projects
  try {
    const { getAllProjects } = await import('../projects.js');
    const { ensureSkillsForDir } = await import('../skills.js');
    const projects = getAllProjects();
    registerChannelForAll(projects.map(p => p.dataDir));
    for (const p of projects) {
      ensureSkillsForDir(p.dataDir.replace(/\/.hotsheet\/?$/, ''));
    }
  } catch {
    registerChannel(dataDir);
  }
  notifyChange();
  return c.json({ ok: true });
});

channelRoutes.post('/channel/disable', async (c) => {
  const { unregisterChannel, unregisterChannelForAll } = await import('../channel-config.js');
  const { writeGlobalConfig } = await import('../global-config.js');
  const dataDir = c.get('dataDir');
  writeGlobalConfig({ channelEnabled: false });
  try {
    const { getAllProjects } = await import('../projects.js');
    unregisterChannelForAll(getAllProjects().map(p => p.dataDir));
  } catch {
    unregisterChannel(dataDir);
  }
  notifyChange();
  return c.json({ ok: true });
});

/** Called by the channel server process when it starts or stops, to wake the long-poll. */
channelRoutes.post('/channel/notify', (c) => {
  console.log(`[notify] channel/notify received — waking poll + permission waiters`);
  notifyChange();
  return c.json({ ok: true });
});

/** Called by the channel server when a permission request arrives, to wake the permission long-poll. */
channelRoutes.post('/channel/permission/notify', (c) => {
  console.log(`[perm] notify received, waking waiters at ${Date.now()}`);
  notifyPermission();
  return c.json({ ok: true });
});

// --- Ping/pong busy detection ---
// Sends a lightweight channel event to Claude and waits for a callback.
// If Claude responds quickly, it's idle. If not, it's busy.

const pendingPings = new Map<string, (idle: boolean) => void>();

/** POST /api/channel/ping — initiate a ping and wait for pong (up to 5s) */
channelRoutes.post('/channel/ping', async (c) => {
  const { getChannelPort } = await import('../channel-config.js');
  const dataDir = c.get('dataDir');
  const port = getChannelPort(dataDir);
  if (port === null) return c.json({ idle: false, reason: 'no-channel' });

  const nonce = Math.random().toString(36).slice(2);
  const { readFileSettings } = await import('../file-settings.js');
  const settings = readFileSettings(dataDir);
  const serverPort = settings.port ?? 4174;
  const secret = settings.secret ?? '';
  const callbackUrl = `http://localhost:${serverPort}/api/channel/pong?nonce=${nonce}` +
    (secret !== '' ? `&secret=${encodeURIComponent(secret)}` : '');

  // Send ping to channel server which forwards to Claude
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce, callbackUrl }),
    });
    if (!res.ok) return c.json({ idle: false, reason: 'ping-failed' });
  } catch {
    return c.json({ idle: false, reason: 'channel-unreachable' });
  }

  // Wait for pong (up to 5 seconds)
  const idle = await new Promise<boolean>((resolve) => {
    pendingPings.set(nonce, resolve);
    setTimeout(() => {
      if (pendingPings.has(nonce)) {
        pendingPings.delete(nonce);
        resolve(false); // Timeout — Claude is busy
      }
    }, 5000);
  });

  return c.json({ idle });
});

/** POST /api/channel/pong — Claude responds to a ping.
 *  The nonce itself serves as authentication (only the intended Claude session has it). */
channelRoutes.post('/channel/pong', (c) => {
  const nonce = c.req.query('nonce') ?? '';
  if (nonce === '') return c.json({ error: 'missing nonce' }, 400);
  const waiter = pendingPings.get(nonce);
  if (waiter) {
    pendingPings.delete(nonce);
    waiter(true); // Claude responded — it's idle
  }
  return c.json({ ok: true });
});
