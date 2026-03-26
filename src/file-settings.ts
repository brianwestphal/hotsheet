import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

export interface FileSettings {
  appName?: string;
  appIcon?: string;
  backupDir?: string;
  secret?: string;
  secretPathHash?: string;
  port?: number;
}

function settingsPath(dataDir: string): string {
  return join(dataDir, 'settings.json');
}

export function readFileSettings(dataDir: string): FileSettings {
  const path = settingsPath(dataDir);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
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

/** Returns the resolved backup directory path. Defaults to {dataDir}/backups if not configured. */
export function getBackupDir(dataDir: string): string {
  const settings = readFileSettings(dataDir);
  return settings.backupDir || join(dataDir, 'backups');
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

  if (settings.secret && settings.secretPathHash === currentPathHash) {
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
