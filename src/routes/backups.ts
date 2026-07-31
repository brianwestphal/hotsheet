import { Hono } from 'hono';

import { cleanupPreview, createBackup, listBackups, loadBackupForPreview, restoreBackup, triggerManualBackup } from '../backup.js';
import { clearRecoveryMarker } from '../db/connection.js';
import { getBackupDir, readFileSettings } from '../file-settings.js';
import { revealInFileManager } from '../open-in-file-manager.js';
import { findStrandedBackupRoots } from '../strandedBackups.js';
import { scheduleAllSync } from '../sync/markdown.js';
import type { AppEnv } from '../types.js';
import { getErrorMessage } from '../utils/errorMessage.js';
import { CreateBackupSchema, parseBody, RestoreBackupSchema } from './validation.js';

export const backupRoutes = new Hono<AppEnv>();

backupRoutes.get('/', async (c) => {
  const dataDir = c.get('dataDir');
  const backups = await listBackups(dataDir);
  return c.json({ backups });
});

/** HS-9536 — backup roots a `backupDir` change left behind.
 *
 * Read-only and best-effort: every filesystem touch goes through `backupFs`, so
 * an unreachable abandoned root (the common case — that is often WHY it was
 * abandoned) degrades to a null size rather than stalling the request. */
backupRoutes.get('/stranded', async (c) => {
  const dataDir = c.get('dataDir');
  const settings = readFileSettings(dataDir);
  const roots = await findStrandedBackupRoots(settings.previousBackupDirs ?? [], getBackupDir(dataDir));
  return c.json({ roots });
});

/** HS-9536 — reveal an abandoned root in the OS file manager.
 *
 * The path is NOT taken from the request at face value: it must match one of the
 * roots `/stranded` would currently report. This endpoint is authenticated and
 * local, but "reveal whatever path the body names" is a capability worth not
 * handing out, and the constraint costs one recomputation. */
backupRoutes.post('/stranded/reveal', async (c) => {
  const dataDir = c.get('dataDir');
  const body: unknown = await c.req.json().catch(() => null);
  const requested = typeof body === 'object' && body !== null ? (body as { path?: unknown }).path : undefined;
  if (typeof requested !== 'string' || requested === '') return c.json({ error: 'path required' }, 400);

  const settings = readFileSettings(dataDir);
  const roots = await findStrandedBackupRoots(settings.previousBackupDirs ?? [], getBackupDir(dataDir));
  if (!roots.some(r => r.path === requested)) return c.json({ error: 'not a reported stranded root' }, 400);

  await revealInFileManager(requested);
  return c.json({ ok: true });
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
    const msg = getErrorMessage(err);
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
    const msg = getErrorMessage(err);
    return c.json({ error: msg }, 500);
  }
});
