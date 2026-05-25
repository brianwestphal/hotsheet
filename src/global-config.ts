import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';

/** HS-8290 — visibility grouping shape inside the global dashboard block.
 *  Each grouping owns the hidden-id sets for EVERY project, keyed by secret.
 *  Pre-HS-8290 the same shape lived per-project as `{id, name, hiddenIds: string[]}`
 *  duplicated across every project's settings.json; that's now collapsed
 *  into a single global record so the dashboard view (which is inherently
 *  cross-project) stops needing the per-project fan-out machinery. */
const VisibilityGroupingSchema = z.object({
  id: z.string(),
  name: z.string(),
  hiddenByProject: z.record(z.string(), z.array(z.string())),
});

const DashboardConfigSchema = z.object({
  // HS-8292 — pre-fix this enum was `['sectioned', 'flat']`, but the client
  // (`src/client/terminalDashboard.tsx`) emits `'flow'`, so every PATCH
  // failed validation and flow mode never persisted across reloads.
  layoutMode: z.enum(['sectioned', 'flow']).optional(),
  columnsPerRow: z.number().optional(),
  visibilityGroupings: z.array(VisibilityGroupingSchema).optional(),
  activeVisibilityGroupingId: z.string().optional(),
  // HS-8424 — HS-8406 added per-scope active-grouping selection on the
  // client; this storage schema must also accept the key, otherwise a
  // stored config containing it would parse as empty on read.
  activeVisibilityGroupingIdByScope: z.record(z.string(), z.string()).optional(),
}).strict();

const GlobalConfigSchema = z.object({
  channelEnabled: z.boolean().optional(),
  shareTotalSeconds: z.number().optional(),
  shareLastPrompted: z.string().optional(),
  shareAccepted: z.boolean().optional(),
  // HS-8290 — terminal-dashboard settings (formerly stored per-project but
  // are inherently cross-project since the dashboard shows tiles for every
  // registered project in one view). See docs/39-visibility-groupings.md.
  dashboard: DashboardConfigSchema.optional(),
  // HS-8446 — global diagnostics opt-in. When true, the slow-server
  // banner (HS-8175 / HS-8226) is allowed to surface AND the HS-8054
  // UI-hang toast fires. Default false so the noisier diagnostic
  // surfaces stay opt-in across every project on this machine. The
  // freeze-log entries (`<dataDir>/freeze.log`) and the server-side
  // event-loop heartbeat continue to fire regardless — the gate only
  // suppresses the in-window UI surfaces.
  diagnosticsEnabled: z.boolean().optional(),
  // HS-8488 — "use software rendering for terminals" opt-out. When true,
  // terminals skip the WebGL renderer addon and use xterm's DOM renderer.
  // Default false (WebGL on). Global / machine-level because terminal
  // rendering is a machine preference (GPU, battery), not per-project — same
  // rationale as the CLI-tool + diagnostics settings. See docs/22-terminal.md.
  terminalWebglOptOut: z.boolean().optional(),
  // HS-8497 — billing model for telemetry cost display. `'api'` (default)
  // = the OpenTelemetry `claude_code.cost.usage` metric reflects the real
  // pay-per-token API cost the user is charged. `'subscription'` = the
  // user is on Claude Pro / Max (flat monthly fee), so the metric value
  // is an API-equivalent estimate, not an amount the user actually pays.
  // The cost UI (per-tab chip + drawer + dashboard) hides or annotates
  // amounts accordingly when this is set to `'subscription'`. Stored
  // globally because the user's billing relationship with Anthropic is
  // identity-level, not per-project.
  telemetryCostMode: z.enum(['api', 'subscription']).optional(),
}).strict();

export type VisibilityGroupingPersisted = z.infer<typeof VisibilityGroupingSchema>;
export type DashboardConfig = z.infer<typeof DashboardConfigSchema>;
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
    // empty-config + behavioral reset.
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
