import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { globalHotsheetDir } from './global-dir.js';
import type { GlobalConfig } from './routes/validation.js';
// HS-8635 — the config schemas (`VisibilityGroupingSchema` / `DashboardConfigSchema`
// / `GlobalConfigSchema`) are the wire SSOT in `routes/validation.ts` (client-safe,
// zod-only) and shared by the typed API layer (`src/api/settings.ts`) + the client.
// This module owns only the fs read/write of `~/.hotsheet/config.json`. The three
// schemas were previously duplicated verbatim here — see docs/39-visibility-groupings.md.
import { GlobalConfigSchema } from './routes/validation.js';

export type { DashboardConfig, GlobalConfig, VisibilityGroupingPersisted } from './routes/validation.js';

function getConfigPath(): string {
  return join(globalHotsheetDir(), 'config.json');
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
    // empty-config + behavioral reset.
    if (err instanceof Error && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[config] Failed to read config.json: ${err.message}`);
    }
    return {};
  }
}

export function writeGlobalConfig(updates: Partial<GlobalConfig>): GlobalConfig {
  const dir = globalHotsheetDir();
  mkdirSync(dir, { recursive: true });
  const current = readGlobalConfig();
  // HS-8290 — single-level deep merge for nested object fields (currently
  // just `dashboard`) so a PATCH like `{ dashboard: { layoutMode: 'flat' } }`
  // doesn't blow away `dashboard.visibilityGroupings` and friends.
  const merged: GlobalConfig = { ...current };
  for (const [k, v] of Object.entries(updates)) {
    const currentVal = (current as Record<string, unknown>)[k];
    const isPlainObj = (x: unknown): x is Record<string, unknown> =>
      x !== null && typeof x === 'object' && !Array.isArray(x);
    if (isPlainObj(v) && isPlainObj(currentVal)) {
      (merged as Record<string, unknown>)[k] = { ...currentVal, ...v };
    } else {
      (merged as Record<string, unknown>)[k] = v;
    }
  }
  writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  return merged;
}
