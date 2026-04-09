import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface GlobalConfig {
  channelEnabled?: boolean;
  shareTotalSeconds?: number;
  shareLastPrompted?: string;
  shareAccepted?: boolean;
}

function getConfigPath(): string {
  return join(homedir(), '.hotsheet', 'config.json');
}

export function readGlobalConfig(): GlobalConfig {
  const path = getConfigPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as GlobalConfig;
  } catch {
    return {};
  }
}

export function writeGlobalConfig(updates: Partial<GlobalConfig>): GlobalConfig {
  const dir = join(homedir(), '.hotsheet');
  mkdirSync(dir, { recursive: true });
  const current = readGlobalConfig();
  const merged = { ...current, ...updates };
  writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  return merged;
}
