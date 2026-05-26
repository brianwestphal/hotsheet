/**
 * HS-8635 (HS-8522 typed-API layer) — typed callers + wire schemas for the
 * settings / file-settings / global-config domains (`src/routes/settings.ts`,
 * `src/routes/dashboard.ts`).
 *
 * Three endpoints, three shapes:
 *   - `/settings` — DB key/value store, all values are strings
 *     (`Record<string,string>`).
 *   - `/file-settings` — the per-project `settings.json`. An open-ended record
 *     whose KNOWN keys are enumerated here (the SSOT — HS-8635 Option A) +
 *     `.loose()` so any not-yet-enumerated key still passes through typed as
 *     `unknown`. Each known field is `.catch(undefined)` so a single
 *     legacy / hand-edited mistyped value degrades to `undefined` instead of
 *     throwing away the whole response (mirrors the server read's
 *     return-`{}`-on-parse-failure posture in `src/file-settings.ts`).
 *   - `/global-config` — `~/.hotsheet/config.json`; reuses the shared
 *     `GlobalConfigSchema` (the wire SSOT in `routes/validation.ts`, also
 *     consumed by `src/global-config.ts`'s fs read/write).
 *
 * The two `apiWithSecret` call sites (cross-project `terminal_default` read +
 * cross-project quit-confirm write) are served by the optional `secret` arg
 * that forwards to `apiCall`'s `opts.secret`.
 */
import { z } from 'zod';

import { type GlobalConfig, GlobalConfigSchema, type UpdateFileSettingsSchema, type UpdateSettingsSchema } from '../routes/validation.js';
import { apiCall, type OkResponse, OkResponseSchema } from './_runner.js';

// Re-export the shared global-config wire shape so callers can import it from
// the typed-API layer alongside the other resource types.
export { GlobalConfigSchema };
export type { GlobalConfig };

/** `GET /settings` → the DB key/value store (every value a string). */
export const SettingsSchema = z.record(z.string(), z.string());

/**
 * `GET /file-settings` (sans `secret` / `secretPathHash` / `port`, which the
 * server strips). The known keys are enumerated as the SSOT; `.loose()` keeps
 * any other key as `unknown`. Read-side value types (what the GETs consumed
 * via their old inline annotations) — several keys are stored as native JSON
 * but legacy code reads string-or-native, hence the unions.
 */
export const FileSettingsSchema = z.object({
  // Reserved / infrastructure (the readable subset).
  appName: z.string().optional().catch(undefined),
  appIcon: z.string().optional().catch(undefined),
  backupDir: z.string().optional().catch(undefined),
  ticketPrefix: z.string().optional().catch(undefined),
  // JSON-valued keys (stored native; some readers tolerate the stringified form).
  terminals: z.union([z.string(), z.array(z.unknown())]).optional().catch(undefined),
  terminal_default: z.unknown().optional(),
  permission_allow_rules: z.unknown().optional(),
  quit_confirm_exempt_processes: z.union([z.string(), z.array(z.string())]).optional().catch(undefined),
  // Scalars.
  confirm_quit_with_running_terminals: z.string().optional().catch(undefined),
  db_snapshot_protection: z.boolean().optional().catch(undefined),
  drawer_open: z.union([z.string(), z.boolean()]).optional().catch(undefined),
  drawer_active_tab: z.string().optional().catch(undefined),
  drawer_expanded: z.union([z.string(), z.boolean()]).optional().catch(undefined),
  telemetry_enabled: z.boolean().optional().catch(undefined),
  telemetry_metrics_enabled: z.boolean().optional().catch(undefined),
  telemetry_logs_enabled: z.boolean().optional().catch(undefined),
  telemetry_traces_enabled: z.boolean().optional().catch(undefined),
  telemetry_retention_days: z.number().optional().catch(undefined),
  terminal_scrollback_bytes: z.union([z.string(), z.number()]).optional().catch(undefined),
}).loose();
/** The per-project `settings.json` shape, client-side. The index signature
 *  (`.loose()`) means a not-yet-enumerated key reads as `unknown`. */
export type FileSettings = z.infer<typeof FileSettingsSchema>;

export type UpdateSettingsReq = z.infer<typeof UpdateSettingsSchema>;
export type UpdateFileSettingsReq = z.infer<typeof UpdateFileSettingsSchema>;

// --- Typed callers ---

/** GET `/settings` → the DB key/value store. */
export async function getSettings(): Promise<Record<string, string>> {
  return apiCall(SettingsSchema, '/settings');
}

/** PATCH `/settings` → upsert one or more string key/value pairs. */
export async function updateSettings(patch: Record<string, string>): Promise<OkResponse> {
  return apiCall(OkResponseSchema, '/settings', { method: 'PATCH', body: patch });
}

/** GET `/file-settings` → the project's `settings.json`. `secret` forwards to a
 *  specific project (cross-project reads) via `apiWithSecret`. */
export async function getFileSettings(secret?: string): Promise<FileSettings> {
  return apiCall(FileSettingsSchema, '/file-settings', { secret });
}

/** PATCH `/file-settings` → merge a partial into `settings.json`; returns the
 *  updated record. `secret` forwards to a specific project. */
export async function updateFileSettings(patch: Partial<FileSettings>, secret?: string): Promise<FileSettings> {
  return apiCall(FileSettingsSchema, '/file-settings', { method: 'PATCH', body: patch, secret });
}

/** GET `/global-config` → `~/.hotsheet/config.json`. */
export async function getGlobalConfig(): Promise<GlobalConfig> {
  return apiCall(GlobalConfigSchema, '/global-config');
}

/** PATCH `/global-config` → deep-merge a partial; returns the merged config. */
export async function updateGlobalConfig(patch: Partial<GlobalConfig>): Promise<GlobalConfig> {
  return apiCall(GlobalConfigSchema, '/global-config', { method: 'PATCH', body: patch });
}
