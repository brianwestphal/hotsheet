import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { z } from 'zod';

const FileSettingsSchema = z.object({
  appName: z.string().optional(),
  appIcon: z.string().optional(),
  backupDir: z.string().optional(),
  ticketPrefix: z.string().optional(),
  secret: z.string().optional(),
  secretPathHash: z.string().optional(),
  port: z.number().optional(),
}).loose();

/** Keys reserved for server/infrastructure use — not project settings. */
const RESERVED_KEYS = new Set(['appName', 'appIcon', 'backupDir', 'ticketPrefix', 'secret', 'secretPathHash', 'port']);

/** Setting keys whose values are JSON (arrays/objects) rather than plain strings.
 *  These are stored as native JSON in settings.json and stringified for the API. */
const JSON_VALUE_KEYS = new Set([
  'categories', 'custom_views', 'custom_commands', 'auto_context', 'terminals',
  // HS-7596 — quit-confirm exempt list (array of process basenames).
  'quit_confirm_exempt_processes',
  // HS-7825 — persisted hidden-terminal ids (configured terminals only;
  // dynamic terminals are session-only). See docs/38-terminal-visibility.md.
  'hidden_terminals',
]);

export interface FileSettings {
  appName?: string;
  appIcon?: string;
  backupDir?: string;
  ticketPrefix?: string;
  secret?: string;
  secretPathHash?: string;
  port?: number;
  [key: string]: unknown;
}

function settingsPath(dataDir: string): string {
  return join(dataDir, 'settings.json');
}

export function readFileSettings(dataDir: string): FileSettings {
  const path = settingsPath(dataDir);
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const result = FileSettingsSchema.safeParse(raw);
    if (!result.success) {
      console.warn(`[settings] Invalid settings.json in ${dataDir}: ${result.error.message}`);
      return {};
    }
    return result.data;
  } catch {
    return {};
  }
}

export function writeFileSettings(dataDir: string, updates: Partial<FileSettings>): FileSettings {
  const current = readFileSettings(dataDir);
  const merged = { ...current, ...updates };
  writeFileSync(settingsPath(dataDir), JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  return merged;
}

/** Read project settings from settings.json as Record\<string, string\> for API compatibility.
 *  JSON-valued keys are stringified. Reserved keys (appName, secret, etc.) are excluded. */
export function readProjectSettings(dataDir: string): Record<string, string> {
  const all = readFileSettings(dataDir);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(all)) {
    if (RESERVED_KEYS.has(key)) continue;
    if (value === undefined || value === null) continue;
    // JSON-valued keys: stringify objects/arrays for API compatibility
    if (typeof value === 'object') {
      result[key] = JSON.stringify(value);
    } else if (typeof value === 'string') {
      result[key] = value;
    } else {
      result[key] = JSON.stringify(value);
    }
  }
  return result;
}

/** Write project settings to settings.json at the root level.
 *  Values for JSON keys are parsed from strings to native JSON before storage. */
export function writeProjectSettings(dataDir: string, updates: Record<string, string>): Record<string, string> {
  const fileUpdates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (JSON_VALUE_KEYS.has(key)) {
      // Try to parse as JSON for native storage
      try { fileUpdates[key] = JSON.parse(value); }
      catch { fileUpdates[key] = value; }
    } else {
      fileUpdates[key] = value;
    }
  }
  writeFileSettings(dataDir, fileUpdates);
  return readProjectSettings(dataDir);
}

/** Returns the resolved backup directory path. Defaults to `\{dataDir\}/backups` if not configured. */
export function getBackupDir(dataDir: string): string {
  const settings = readFileSettings(dataDir);
  return typeof settings.backupDir === 'string' && settings.backupDir !== '' ? settings.backupDir : join(dataDir, 'backups');
}

/** Hash the absolute path of settings.json for path-change detection. */
function hashPath(dataDir: string): string {
  const absPath = resolve(settingsPath(dataDir));
  return createHash('sha256').update(absPath).digest('hex').slice(0, 16);
}

/**
 * Ensure a secret exists in settings.json. Regenerate if the data dir path has changed
 * (detected via path hash mismatch). Also writes the current port.
 * Returns the active secret.
 */
export function ensureSecret(dataDir: string, port: number): string {
  const settings = readFileSettings(dataDir);
  const currentPathHash = hashPath(dataDir);

  if (settings.secret !== undefined && settings.secret !== '' && settings.secretPathHash === currentPathHash) {
    // Secret exists and path hasn't changed — just update port
    if (settings.port !== port) {
      writeFileSettings(dataDir, { port });
    }
    return settings.secret;
  }

  // Generate new secret: hash of absolute path + random value
  const random = randomBytes(32).toString('hex');
  const absPath = resolve(settingsPath(dataDir));
  const secret = createHash('sha256').update(absPath + random).digest('hex').slice(0, 32);

  writeFileSettings(dataDir, { secret, secretPathHash: currentPathHash, port });
  return secret;
}
