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
  } catch (err: unknown) {
    // HS-8087 — pre-fix this catch was silent. Surface non-ENOENT read
    // errors (permission denied, disk I/O failures, JSON parse on a
    // partial write) so the user notices instead of getting a silent
    // empty-config + behavioural reset.
    if (err instanceof Error && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[config] Failed to read config.json: ${err.message}`);
    }
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
