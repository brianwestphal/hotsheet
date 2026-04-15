import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';

const GlobalConfigSchema = z.object({
  channelEnabled: z.boolean().optional(),
  shareTotalSeconds: z.number().optional(),
  shareLastPrompted: z.string().optional(),
  shareAccepted: z.boolean().optional(),
}).strict();

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

function getConfigPath(): string {
  return join(homedir(), '.hotsheet', 'config.json');
}

export function readGlobalConfig(): GlobalConfig {
  const path = getConfigPath();
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const result = GlobalConfigSchema.safeParse(raw);
    if (!result.success) {
      console.warn(`[config] Invalid config.json: ${result.error.message}`);
      return {};
    }
    return result.data;
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
