/**
 * HS-8637 (HS-8522 typed-API layer) — typed callers + wire schemas for the
 * plugins domain (`src/routes/plugins.ts`): plugin list / detail / UI elements
 * / bundled catalog / install / enable-disable / action / config-labels /
 * global-config / sync trigger + the cross-cutting `/backends`, `/sync/tickets`,
 * `/sync/conflicts` reads and the conflict-resolve write.
 *
 * This module is the SSOT for the plugin data shapes (`PluginInfo`,
 * `PluginPreference`, `ConfigLayoutItem`, `ConfigLabelColor`, `SyncConflict`,
 * `PluginUIElement`, `BundledPluginInfo`) — `src/client/pluginTypes.tsx`
 * re-exports the inferred types so existing consumers keep their import path.
 * Request bodies reuse the schemas already in `src/routes/validation.ts`
 * (`PluginActionSchema` / `PluginConflictResolveSchema` / `PluginInstallSchema`
 * / `PluginGlobalConfigSchema`), which the server already validates.
 */
import { z } from 'zod';

import {
  type PluginActionSchema, type PluginConflictResolveSchema,
  type PluginGlobalConfigSchema, type PluginInstallSchema, type PluginValidateSchema,
} from '../routes/validation.js';
import { apiCall, type OkResponse, OkResponseSchema } from './_runner.js';

// --- Shared plugin data types (SSOT; re-exported by `pluginTypes.tsx`) ---

export const ConfigLabelColorSchema = z.enum(['default', 'success', 'error', 'warning', 'transient']);
export type ConfigLabelColor = z.infer<typeof ConfigLabelColorSchema>;

/** A config-layout node. Recursive (`group` items nest), so the interface is
 *  declared explicitly and the schema is `z.lazy`-wrapped + typed against it. */
export interface ConfigLayoutItem {
  type: 'preference' | 'divider' | 'spacer' | 'label' | 'button' | 'group';
  key?: string;
  id?: string;
  text?: string;
  color?: ConfigLabelColor;
  label?: string;
  action?: string;
  icon?: string;
  style?: string;
  title?: string;
  collapsed?: boolean;
  items?: ConfigLayoutItem[];
}
export const ConfigLayoutItemSchema: z.ZodType<ConfigLayoutItem> = z.lazy(() => z.object({
  type: z.enum(['preference', 'divider', 'spacer', 'label', 'button', 'group']),
  key: z.string().optional(),
  id: z.string().optional(),
  text: z.string().optional(),
  color: ConfigLabelColorSchema.optional(),
  label: z.string().optional(),
  action: z.string().optional(),
  icon: z.string().optional(),
  style: z.string().optional(),
  title: z.string().optional(),
  collapsed: z.boolean().optional(),
  items: z.array(ConfigLayoutItemSchema).optional(),
}));

export const PluginPreferenceSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['string', 'boolean', 'number', 'select', 'dropdown', 'combo']),
  default: z.union([z.string(), z.boolean(), z.number()]).optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  secret: z.boolean().optional(),
  scope: z.enum(['global', 'project']).optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
});
export type PluginPreference = z.infer<typeof PluginPreferenceSchema>;

/** Plugin record. The LIST endpoint (`GET /plugins`) omits `author` /
 *  `configLayout` / `path`; the DETAIL endpoint (`GET /plugins/:id`) includes
 *  them — so those (plus the always-present-but-defensive `needsConfiguration`
 *  / `missingFields`) are optional here, covering both responses with one
 *  schema. */
export const PluginInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().nullable(),
  author: z.string().nullable().optional(),
  enabled: z.boolean(),
  hasBackend: z.boolean(),
  error: z.string().nullable(),
  preferences: z.array(PluginPreferenceSchema),
  configLayout: z.array(ConfigLayoutItemSchema).optional(),
  path: z.string().optional(),
  needsConfiguration: z.boolean().optional(),
  missingFields: z.array(z.string()).optional(),
});
export type PluginInfo = z.infer<typeof PluginInfoSchema>;

/** A plugin-registered UI element (`GET /plugins/ui`). */
export const PluginUIElementSchema = z.object({
  id: z.string(),
  type: z.string(),
  location: z.string(),
  label: z.string().optional(),
  icon: z.string().optional(),
  title: z.string().optional(),
  color: z.string().optional(),
  style: z.string().optional(),
  action: z.string().optional(),
  url: z.string().optional(),
  _pluginId: z.string().optional(),
});
export type PluginUIElement = z.infer<typeof PluginUIElementSchema>;

/** A bundled (official) plugin with install status (`GET /plugins/bundled`). */
export const BundledPluginInfoSchema = z.object({
  manifest: z.object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    description: z.string().optional(),
    icon: z.string().optional(),
  }),
  installed: z.boolean(),
  dismissed: z.boolean(),
});
export type BundledPluginInfo = z.infer<typeof BundledPluginInfoSchema>;

/** A sync conflict row as the settings UI consumes it. The server returns the
 *  full `TicketSyncRecord` (9 fields); the extra columns are stripped here
 *  since the conflict list only renders these six. */
export const SyncConflictSchema = z.object({
  id: z.number(),
  ticket_id: z.number(),
  plugin_id: z.string(),
  remote_id: z.string(),
  sync_status: z.string(),
  conflict_data: z.string().nullable(),
});
export type SyncConflict = z.infer<typeof SyncConflictSchema>;

/** HS-8959 — `GET /sync/conflicts/summary`: per-plugin unresolved-conflict counts
 *  (with display name + icon) for the global conflict banner. Generic across
 *  plugins, not GitHub-specific. */
export const SyncConflictSummaryEntrySchema = z.object({
  pluginId: z.string(),
  pluginName: z.string(),
  icon: z.string().nullable(),
  count: z.number(),
});
export type SyncConflictSummaryEntry = z.infer<typeof SyncConflictSummaryEntrySchema>;

/** A connected backend (`GET /backends`). The server also returns
 *  `capabilities`; the context-menu consumer needs only id + name, so the
 *  extra field is stripped. */
export const BackendInfoSchema = z.object({ id: z.string(), name: z.string() });
export type BackendInfo = z.infer<typeof BackendInfoSchema>;

const SyncTicketInfoSchema = z.object({ pluginId: z.string(), icon: z.string().optional() });
/** `GET /sync/tickets` → `{ [ticketId]: {pluginId, icon?} }`. JSON object keys
 *  are strings; the consumer iterates with `Object.entries`. */
export const SyncTicketsMapSchema = z.record(z.string(), SyncTicketInfoSchema);
export type SyncTicketsMap = z.infer<typeof SyncTicketsMapSchema>;

/** `GET /plugins/config-labels/:id` → `{ [labelId]: {text, color?} }`. */
export const ConfigLabelsSchema = z.record(z.string(), z.object({ text: z.string(), color: z.string().optional() }));
export type ConfigLabels = z.infer<typeof ConfigLabelsSchema>;

const GlobalConfigValueSchema = z.object({ value: z.string().nullable() });

/** `POST /plugins/:id/sync` result (`runSync` → `SyncResult`). */
export const SyncResultSchema = z.object({
  ok: z.boolean(),
  pulled: z.number().optional(),
  pushed: z.number().optional(),
  conflicts: z.number().optional(),
  error: z.string().optional(),
});
export type SyncResult = z.infer<typeof SyncResultSchema>;

/** HS-8791 — `GET /plugins/:id/pending-count`: how out of sync the project is in
 *  both directions, for the sync-button badge. */
export const PendingSyncCountSchema = z.object({
  toPull: z.number(),
  toPush: z.number(),
  total: z.number(),
  ok: z.boolean(),
});
export type PendingSyncCount = z.infer<typeof PendingSyncCountSchema>;

/** `POST /plugins/:id/action` result. The plugin's `onAction` return value is
 *  opaque except for the two control fields the UI acts on (`redirect` triggers
 *  a follow-up sync; `message` becomes a toast); `.loose()` keeps any
 *  plugin-specific extras. */
const PluginActionResultSchema = z.object({
  ok: z.literal(true),
  result: z.object({ redirect: z.string().optional(), message: z.string().optional() }).loose().optional(),
});

/** `POST /plugins/install` result. */
const PluginInstallResultSchema = z.object({ ok: z.literal(true), installed: z.string() });

/** `POST /plugins/validate/:id` result — the plugin's `validateField` return,
 *  or `null` when the plugin has no validator / validation threw. */
const PluginValidationResultSchema = z.object({ status: z.string(), message: z.string() }).nullable();

export type PluginActionReq = z.infer<typeof PluginActionSchema>;
export type PluginConflictResolveReq = z.infer<typeof PluginConflictResolveSchema>;
export type PluginInstallReq = z.infer<typeof PluginInstallSchema>;
export type PluginGlobalConfigReq = z.infer<typeof PluginGlobalConfigSchema>;
export type PluginValidateReq = z.infer<typeof PluginValidateSchema>;

// --- Typed callers ---

/** GET `/plugins` → every loaded plugin (per-project enabled state resolved). */
export async function listPlugins(): Promise<PluginInfo[]> {
  return apiCall(z.array(PluginInfoSchema), '/plugins');
}

/** GET `/plugins/:id` → one plugin's full detail (incl. `configLayout` + `path`). */
export async function getPlugin(id: string): Promise<PluginInfo> {
  return apiCall(PluginInfoSchema, `/plugins/${encodeURIComponent(id)}`);
}

/** GET `/plugins/ui` → UI elements registered by enabled plugins. */
export async function getPluginUiElements(): Promise<PluginUIElement[]> {
  return apiCall(z.array(PluginUIElementSchema), '/plugins/ui');
}

/** GET `/plugins/bundled` → official plugin catalog with install status. */
export async function getBundledPlugins(): Promise<BundledPluginInfo[]> {
  return apiCall(z.array(BundledPluginInfoSchema), '/plugins/bundled');
}

/** POST `/plugins/bundled/:id/install` → install a bundled plugin by id. */
export async function installBundledPlugin(id: string): Promise<OkResponse> {
  return apiCall(OkResponseSchema, `/plugins/bundled/${encodeURIComponent(id)}/install`, { method: 'POST' });
}

/** POST `/plugins/install` → symlink-install a plugin from a local path. */
export async function installPlugin(path: string): Promise<z.infer<typeof PluginInstallResultSchema>> {
  const body: PluginInstallReq = { path };
  return apiCall(PluginInstallResultSchema, '/plugins/install', { method: 'POST', body });
}

/** POST `/plugins/:id/enable` → enable the plugin for the current project. */
export async function enablePlugin(id: string): Promise<OkResponse> {
  return apiCall(OkResponseSchema, `/plugins/${encodeURIComponent(id)}/enable`, { method: 'POST' });
}

/** POST `/plugins/:id/disable` → disable the plugin for the current project. */
export async function disablePlugin(id: string): Promise<OkResponse> {
  return apiCall(OkResponseSchema, `/plugins/${encodeURIComponent(id)}/disable`, { method: 'POST' });
}

/** POST `/plugins/:id/enable-all` → enable the plugin on every open project. */
export async function enablePluginEverywhere(id: string): Promise<OkResponse> {
  return apiCall(OkResponseSchema, `/plugins/${encodeURIComponent(id)}/enable-all`, { method: 'POST' });
}

/** POST `/plugins/:id/disable-all` → disable the plugin on every open project. */
export async function disablePluginEverywhere(id: string): Promise<OkResponse> {
  return apiCall(OkResponseSchema, `/plugins/${encodeURIComponent(id)}/disable-all`, { method: 'POST' });
}

/** POST `/plugins/:id/uninstall` → uninstall a plugin. */
export async function uninstallPlugin(id: string): Promise<OkResponse> {
  return apiCall(OkResponseSchema, `/plugins/${encodeURIComponent(id)}/uninstall`, { method: 'POST' });
}

/** POST `/plugins/reveal/:id` → open the plugin's directory in the file manager. */
export async function revealPlugin(id: string): Promise<OkResponse> {
  return apiCall(OkResponseSchema, `/plugins/${encodeURIComponent(id)}/reveal`, { method: 'POST' });
}

/** POST `/plugins/:id/sync` → trigger an immediate sync; returns the `SyncResult`. */
export async function triggerPluginSync(id: string): Promise<SyncResult> {
  return apiCall(SyncResultSchema, `/plugins/${encodeURIComponent(id)}/sync`, { method: 'POST' });
}

/** GET `/plugins/:id/pending-count` → how out of sync the project is (HS-8791). */
export async function getPluginPendingCount(id: string): Promise<PendingSyncCount> {
  return apiCall(PendingSyncCountSchema, `/plugins/${encodeURIComponent(id)}/pending-count`);
}

/** `POST /plugins/:id/push-ticket/:ticketId` result. */
const PushTicketResultSchema = z.object({
  ok: z.literal(true),
  remoteId: z.string(),
  remoteUrl: z.string().nullable(),
});

/** POST `/plugins/:id/push-ticket/:ticketId` → create a local-only ticket on the
 *  plugin's remote backend; returns the new remote id + (optional) URL. */
export async function pushTicketToBackend(pluginId: string, ticketId: number): Promise<z.infer<typeof PushTicketResultSchema>> {
  return apiCall(PushTicketResultSchema, `/plugins/${encodeURIComponent(pluginId)}/push-ticket/${ticketId}`, { method: 'POST' });
}

/** POST `/plugins/:id/action` → run a plugin UI action. */
export async function runPluginAction(id: string, body: PluginActionReq): Promise<z.infer<typeof PluginActionResultSchema>> {
  return apiCall(PluginActionResultSchema, `/plugins/${encodeURIComponent(id)}/action`, { method: 'POST', body });
}

/** POST `/plugins/validate/:id` → validate one config field's value. */
export async function validatePluginField(id: string, key: string, value: string): Promise<z.infer<typeof PluginValidationResultSchema>> {
  const body: PluginValidateReq = { key, value };
  return apiCall(PluginValidationResultSchema, `/plugins/validate/${encodeURIComponent(id)}`, { method: 'POST', body });
}

/** GET `/plugins/config-labels/:id` → dynamic config-label overrides. */
export async function getPluginConfigLabels(id: string): Promise<ConfigLabels> {
  return apiCall(ConfigLabelsSchema, `/plugins/config-labels/${encodeURIComponent(id)}`);
}

/** GET `/plugins/:id/global-config/:key` → a global (cross-project) pref value. */
export async function getPluginGlobalConfig(id: string, key: string): Promise<string | null> {
  const r = await apiCall(GlobalConfigValueSchema, `/plugins/${encodeURIComponent(id)}/global-config/${encodeURIComponent(key)}`);
  return r.value;
}

/** POST `/plugins/:id/global-config` → persist a global pref value. */
export async function setPluginGlobalConfig(id: string, key: string, value: string): Promise<OkResponse> {
  const body: PluginGlobalConfigReq = { key, value };
  return apiCall(OkResponseSchema, `/plugins/${encodeURIComponent(id)}/global-config`, { method: 'POST', body });
}

/** GET `/backends` → enabled, fully-configured ticketing backends. */
export async function getBackends(): Promise<BackendInfo[]> {
  return apiCall(z.array(BackendInfoSchema), '/backends');
}

/** GET `/sync/tickets` → synced-ticket → plugin-info map for list indicators. */
export async function getSyncedTickets(): Promise<SyncTicketsMap> {
  return apiCall(SyncTicketsMapSchema, '/sync/tickets');
}

/** GET `/sync/conflicts` → all unresolved sync conflicts. */
export async function getSyncConflicts(): Promise<SyncConflict[]> {
  return apiCall(z.array(SyncConflictSchema), '/sync/conflicts');
}

/** HS-8959 — GET `/sync/conflicts/summary` → per-plugin conflict counts + icons
 *  for the global conflict banner. */
export async function getSyncConflictsSummary(): Promise<SyncConflictSummaryEntry[]> {
  return apiCall(z.array(SyncConflictSummaryEntrySchema), '/sync/conflicts/summary');
}

/** POST `/sync/conflicts/:ticketId/resolve` → resolve a conflict keep-local / keep-remote. */
export async function resolveSyncConflict(ticketId: number, pluginId: string, resolution: PluginConflictResolveReq['resolution']): Promise<OkResponse> {
  const body: PluginConflictResolveReq = { plugin_id: pluginId, resolution };
  return apiCall(OkResponseSchema, `/sync/conflicts/${ticketId}/resolve`, { method: 'POST', body });
}
