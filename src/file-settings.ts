import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface FileSettings {
  appName?: string;
  backupDir?: string;
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
