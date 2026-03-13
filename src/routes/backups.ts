import { Hono } from 'hono';

import { cleanupPreview, createBackup, listBackups, loadBackupForPreview, restoreBackup, triggerManualBackup } from '../backup.js';
import { scheduleAllSync } from '../sync/markdown.js';
import type { AppEnv } from '../types.js';

export const backupRoutes = new Hono<AppEnv>();

backupRoutes.get('/', (c) => {
  const dataDir = c.get('dataDir');
  const backups = listBackups(dataDir);
  return c.json({ backups });
});

backupRoutes.post('/create', async (c) => {
  const dataDir = c.get('dataDir');
  const body = await c.req.json<{ tier: '5min' | 'hourly' | 'daily' }>();
  const info = await createBackup(dataDir, body.tier);
  if (!info) return c.json({ error: 'Backup already in progress' }, 409);
  return c.json(info);
});

backupRoutes.post('/now', async (c) => {
  const dataDir = c.get('dataDir');
  const info = await triggerManualBackup(dataDir);
  if (!info) return c.json({ error: 'Backup already in progress' }, 409);
  return c.json(info);
});

backupRoutes.get('/preview/:tier/:filename', async (c) => {
  const dataDir = c.get('dataDir');
  const tier = c.req.param('tier');
  const filename = c.req.param('filename');
  try {
    const result = await loadBackupForPreview(dataDir, tier, filename);
    return c.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Preview failed';
    return c.json({ error: msg }, 400);
  }
});

backupRoutes.post('/preview/cleanup', async (c) => {
  await cleanupPreview();
  return c.json({ ok: true });
});

backupRoutes.post('/restore', async (c) => {
  const dataDir = c.get('dataDir');
  const body = await c.req.json<{ tier: string; filename: string }>();
  try {
    await restoreBackup(dataDir, body.tier, body.filename);
    scheduleAllSync();
    return c.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Restore failed';
    return c.json({ error: msg }, 500);
  }
});
