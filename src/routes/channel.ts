import { Hono } from 'hono';

import { addLogEntry, getSettings, updateLogEntry, updateSetting } from '../db/queries.js';
import type { AppEnv } from '../types.js';
import { notifyChange } from './notify.js';

export const channelRoutes = new Hono<AppEnv>();

let channelDoneFlag = false;

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
  const dataDir = c.get('dataDir');
  const settings = await getSettings();
  const enabled = settings.channel_enabled === 'true';
  const port = getChannelPort(dataDir);
  const alive = enabled ? await isChannelAlive(dataDir) : false;
  // Consume the done flag (read once, then clear)
  const done = channelDoneFlag;
  if (done) channelDoneFlag = false;
  return c.json({ enabled, alive, port, done });
});

channelRoutes.post('/channel/trigger', async (c) => {
  const { triggerChannel } = await import('../channel-config.js');
  const dataDir = c.get('dataDir');
  const serverPort = parseInt(new URL(c.req.url).port || '4174', 10);
  const body = await c.req.json<{ message?: string }>().catch(() => ({ message: undefined }));
  channelDoneFlag = false; // Reset done flag on new trigger
  loggedPermissionRequests.clear(); // Reset dedup set for new session
  const ok = await triggerChannel(dataDir, serverPort, body.message);
  const summary = body.message !== undefined && body.message !== '' ? body.message.slice(0, 200) : 'Worklist trigger';
  addLogEntry('trigger', 'outgoing', summary, body.message ?? '').catch(() => {});
  return c.json({ ok });
});

channelRoutes.get('/channel/permission', async (c) => {
  const { getChannelPort } = await import('../channel-config.js');
  const dataDir = c.get('dataDir');
  const port = getChannelPort(dataDir);
  if (port === null) return c.json({ pending: null });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/permission`);
    const data = await res.json() as { pending: { request_id?: string; tool_name?: string; description?: string; input_preview?: string; tool_input?: unknown } | null };
    // Log permission requests once per unique request_id
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
    return c.json(data);
  } catch {
    return c.json({ pending: null });
  }
});

channelRoutes.post('/channel/permission/respond', async (c) => {
  const { getChannelPort } = await import('../channel-config.js');
  const dataDir = c.get('dataDir');
  const port = getChannelPort(dataDir);
  if (port === null) return c.json({ error: 'Channel not available' }, 503);
  const body = await c.req.json<{ request_id: string; behavior: 'allow' | 'deny'; tool_name?: string }>();
  const action = body.behavior === 'allow' ? 'Allowed' : 'Denied';
  const toolName = body.tool_name ?? 'tool';
  // Update the existing permission_request entry with the response instead of creating a new one
  const logId = loggedPermissionRequests.get(body.request_id);
  if (logId !== undefined && logId > 0) {
    updateLogEntry(logId, { summary: `Permission: ${toolName} — ${action}` }).catch(() => {});
  } else {
    addLogEntry('permission_request', 'incoming', `Permission: ${toolName} — ${action}`, JSON.stringify(body)).catch(() => {});
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/permission/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
  channelDoneFlag = true;
  addLogEntry('done', 'incoming', 'Claude finished', '').catch(() => {});
  notifyChange(); // Triggers long-poll so client picks up the done state
  return _c.json({ ok: true });
});

channelRoutes.post('/channel/enable', async (c) => {
  const { registerChannel } = await import('../channel-config.js');
  const dataDir = c.get('dataDir');
  await updateSetting('channel_enabled', 'true');
  registerChannel(dataDir);
  notifyChange();
  return c.json({ ok: true });
});

channelRoutes.post('/channel/disable', async (c) => {
  const { unregisterChannel } = await import('../channel-config.js');
  await updateSetting('channel_enabled', 'false');
  unregisterChannel();
  notifyChange();
  return c.json({ ok: true });
});
