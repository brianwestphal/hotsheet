import type { PGlite } from '@electric-sql/pglite';
import { resolve } from 'path';

import { getBackupTimers, initBackupScheduler } from './backup.js';
import { getDbForDir, runWithDataDir } from './db/connection.js';
import { getCategories } from './db/queries.js';
import { ensureSecret, readFileSettings } from './file-settings.js';
import { acquireLock } from './lock.js';
import { ensureSkills, initSkills, setSkillCategories } from './skills.js';
import { getSyncState, initMarkdownSync, scheduleAllSync } from './sync/markdown.js';

export interface ProjectContext {
  dataDir: string;
  name: string;
  secret: string;
  db: PGlite;
  markdownSyncState: { worklistTimeout: ReturnType<typeof setTimeout> | null; openTicketsTimeout: ReturnType<typeof setTimeout> | null };
  backupTimers: { fiveMin: ReturnType<typeof setTimeout> | null; hourly: ReturnType<typeof setInterval> | null; daily: ReturnType<typeof setInterval> | null };
}

// Keyed by secret
const projects = new Map<string, ProjectContext>();

// Secondary index: dataDir -> secret for lookups
const dataDirToSecret = new Map<string, string>();

/**
 * Register a new project. Initializes the database, secret, markdown sync,
 * backup scheduler, and AI tool skills for the given dataDir.
 */
export async function registerProject(dataDir: string, port: number): Promise<ProjectContext> {
  const absDataDir = resolve(dataDir);

  // Check if already registered by dataDir
  const existingSecret = dataDirToSecret.get(absDataDir);
  if (existingSecret !== undefined) {
    const existing = projects.get(existingSecret);
    if (existing) return existing;
  }

  // Initialize PGLite database for this dataDir (creates if needed)
  const db = await getDbForDir(absDataDir);

  // Migrate project settings from DB to settings.json (idempotent)
  const { migrateDbSettingsToFile } = await import('./migrate-settings.js');
  await runWithDataDir(absDataDir, () => migrateDbSettingsToFile(absDataDir));

  // Ensure secret exists and write port to settings.json
  const secret = ensureSecret(absDataDir, port);

  // Acquire lock to prevent duplicate instances
  acquireLock(absDataDir);

  // Initialize markdown sync for this project
  initMarkdownSync(absDataDir, port);
  scheduleAllSync(absDataDir);

  // Initialize and sync AI tool skills — run in this project's DB context
  initSkills(port);
  setSkillCategories(await runWithDataDir(absDataDir, () => getCategories()));
  ensureSkills();

  // Initialize backup scheduler
  initBackupScheduler(absDataDir);

  // Use appName from settings if set, otherwise derive from directory name
  const fileSettings = readFileSettings(absDataDir);
  const dirName = absDataDir.replace(/\/.hotsheet\/?$/, '').split('/').pop() ?? absDataDir;
  const name = (fileSettings.appName !== undefined && fileSettings.appName !== '') ? fileSettings.appName : dirName;

  const syncState = getSyncState(absDataDir);
  const backupTimers = getBackupTimers(absDataDir);

  const ctx: ProjectContext = {
    dataDir: absDataDir,
    name,
    secret,
    db,
    markdownSyncState: syncState ?? { worklistTimeout: null, openTicketsTimeout: null },
    backupTimers,
  };

  projects.set(secret, ctx);
  dataDirToSecret.set(absDataDir, secret);

  return ctx;
}

/**
 * Register a project that was already initialized by cli.ts.
 * This avoids re-running lock/db/sync/backup init that cli.ts already did.
 */
export function registerExistingProject(dataDir: string, secret: string, db: PGlite): ProjectContext {
  const absDataDir = resolve(dataDir);

  // Check if already registered
  const existingSecret = dataDirToSecret.get(absDataDir);
  if (existingSecret !== undefined) {
    const existing = projects.get(existingSecret);
    if (existing) return existing;
  }

  const fileSettings = readFileSettings(absDataDir);
  const dirName = absDataDir.replace(/\/.hotsheet\/?$/, '').split('/').pop() ?? absDataDir;
  const name = (fileSettings.appName !== undefined && fileSettings.appName !== '') ? fileSettings.appName : dirName;
  const syncState = getSyncState(absDataDir);
  const backupTimers = getBackupTimers(absDataDir);

  const ctx: ProjectContext = {
    dataDir: absDataDir,
    name,
    secret,
    db,
    markdownSyncState: syncState ?? { worklistTimeout: null, openTicketsTimeout: null },
    backupTimers,
  };

  projects.set(secret, ctx);
  dataDirToSecret.set(absDataDir, secret);

  return ctx;
}

/** Look up a project by its secret. */
export function getProjectBySecret(secret: string): ProjectContext | undefined {
  return projects.get(secret);
}

/** Look up a project by its dataDir (resolved to absolute path). */
export function getProjectByDataDir(dataDir: string): ProjectContext | undefined {
  const abs = resolve(dataDir);
  const secret = dataDirToSecret.get(abs);
  if (secret === undefined) return undefined;
  return projects.get(secret);
}

/** Get all registered projects. */
export function getAllProjects(): ProjectContext[] {
  return Array.from(projects.values());
}

/** Unregister a project by secret. Does not close the database. */
export function unregisterProject(secret: string): void {
  const ctx = projects.get(secret);
  if (!ctx) return;
  dataDirToSecret.delete(ctx.dataDir);
  projects.delete(secret);
}

/** Reorder projects to match the given secret order. Returns dataDirs in new order. */
export function reorderProjects(secrets: string[]): string[] {
  // getAllProjects iterates the Map in insertion order, so we rebuild it
  const ordered: ProjectContext[] = [];
  for (const secret of secrets) {
    const ctx = projects.get(secret);
    if (ctx) ordered.push(ctx);
  }
  // Add any projects not in the list (shouldn't happen, but be safe)
  for (const ctx of projects.values()) {
    if (!ordered.includes(ctx)) ordered.push(ctx);
  }
  // Rebuild maps in new order
  projects.clear();
  dataDirToSecret.clear();
  for (const ctx of ordered) {
    projects.set(ctx.secret, ctx);
    dataDirToSecret.set(ctx.dataDir, ctx.secret);
  }
  return ordered.map(ctx => ctx.dataDir);
}
