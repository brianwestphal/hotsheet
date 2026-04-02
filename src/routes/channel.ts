import { Hono } from 'hono';

import { getSettings, updateSetting } from '../db/queries.js';
import type { AppEnv } from '../types.js';
import { notifyChange } from './notify.js';

export const channelRoutes = new Hono<AppEnv>();

let channelDoneFlag = false;

channelRoutes.get('/channel/claude-check', async (c) => {
  const { execFileSync } = await import('child_process');
  try {
    const version = execFileSync('claude', ['--version'], { timeout: 5000, encoding: 'utf-8' }).trim();
    // Version string like "Claude Code v2.1.85" or just "2.1.85"
    const match = version.match(/(\d+\.\d+\.\d+)/);
    const versionNum = match ? match[1] : null;
    const parts = versionNum ? versionNum.split('.').map(Number) : [];
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
  const ok = await triggerChannel(dataDir, serverPort, body.message);
  return c.json({ ok });
});

channelRoutes.get('/channel/permission', async (c) => {
  const { getChannelPort } = await import('../channel-config.js');
  const dataDir = c.get('dataDir');
  const port = getChannelPort(dataDir);
  if (!port) return c.json({ pending: null });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/permission`);
    const data = await res.json();
    return c.json(data);
  } catch {
    return c.json({ pending: null });
  }
});

channelRoutes.post('/channel/permission/respond', async (c) => {
  const { getChannelPort } = await import('../channel-config.js');
  const dataDir = c.get('dataDir');
  const port = getChannelPort(dataDir);
  if (!port) return c.json({ error: 'Channel not available' }, 503);
  const body = await c.req.json<{ request_id: string; behavior: 'allow' | 'deny' }>();
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
  if (!port) return c.json({ ok: true });
  try {
    await fetch(`http://127.0.0.1:${port}/permission/dismiss`, { method: 'POST' });
  } catch { /* ignore */ }
  return c.json({ ok: true });
});

channelRoutes.post('/channel/done', async (_c) => {
  channelDoneFlag = true;
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
