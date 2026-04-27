import { Hono } from 'hono';

import { cleanupPreview, createBackup, listBackups, loadBackupForPreview, restoreBackup, triggerManualBackup } from '../backup.js';
import { clearRecoveryMarker } from '../db/connection.js';
import { scheduleAllSync } from '../sync/markdown.js';
import type { AppEnv } from '../types.js';
import { CreateBackupSchema, parseBody, RestoreBackupSchema } from './validation.js';

export const backupRoutes = new Hono<AppEnv>();

backupRoutes.get('/', (c) => {
  const dataDir = c.get('dataDir');
  const backups = listBackups(dataDir);
  return c.json({ backups });
});

backupRoutes.post('/create', async (c) => {
  const dataDir = c.get('dataDir');
  const raw: unknown = await c.req.json();
  const parsed = parseBody(CreateBackupSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const info = await createBackup(dataDir, parsed.data.tier);
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
  const raw: unknown = await c.req.json();
  const parsed = parseBody(RestoreBackupSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  try {
    await restoreBackup(dataDir, parsed.data.tier, parsed.data.filename);
    scheduleAllSync(dataDir);
    // HS-7899: a successful restore resolves the recovery situation, so
    // wipe the marker. Otherwise the launch banner would keep prompting
    // even after the user already recovered.
    clearRecoveryMarker(dataDir);
    return c.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Restore failed';
    return c.json({ error: msg }, 500);
  }
});
