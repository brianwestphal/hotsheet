/**
 * HS-8634 (HS-8522 typed-API layer) — typed callers + wire schemas for the
 * projects domain (`src/routes/projects.ts`): list / register / delete /
 * reorder / channel-status / feedback-state / reveal + the long-poll
 * permission + bell-state heartbeats + the §37 quit-summary aggregator.
 *
 * The `/permissions` + `/bell-state` GETs are long-polls (3 s server-side
 * wait, `?v=` version cursor) — the typed callers just wrap them; the cursor
 * is built at the call site. Every caller accepts an optional `secret` that
 * forwards to `apiCall`'s `opts.secret` (→ `apiWithSecret`) for cross-project
 * operation, matching the terminal / telemetry / channel domains.
 */
import { z } from 'zod';

import { type RegisterProjectSchema, type ReorderProjectsSchema } from '../routes/validation.js';
import { apiCall, type OkResponse, OkResponseSchema, qs } from './_runner.js';

/** `GET /projects` row. (The `schemas.ts` `ProjectListItemSchema` predates
 *  `secret` + is `.loose()`; this is the full client-facing shape.) */
export const ProjectListItemSchema = z.object({
  name: z.string(),
  dataDir: z.string(),
  secret: z.string(),
  ticketCount: z.number(),
  // HS-9056 — open (not_started|started) + up-next counts for the terminal
  // dashboard tile stats cluster. Default to 0 for older servers / rows.
  openCount: z.number().catch(0),
  upNextCount: z.number().catch(0),
});
export type ProjectListItem = z.infer<typeof ProjectListItemSchema>;

/** `POST /projects/register` 201 body. */
export const RegisteredProjectSchema = z.object({
  name: z.string(),
  dataDir: z.string(),
  secret: z.string(),
});
export type RegisteredProject = z.infer<typeof RegisteredProjectSchema>;

const ProjectsChannelStatusSchema = z.object({
  enabled: z.boolean(),
  projects: z.record(z.string(), z.boolean()),
});
export type ProjectsChannelStatus = z.infer<typeof ProjectsChannelStatusSchema>;

const ProjectsFeedbackStateSchema = z.object({ projects: z.record(z.string(), z.boolean()) });

/** A pending-permission entry as the client's popup needs it. The server's
 *  `PendingPermissionEntrySchema` is all-optional (defensive), but the popup
 *  (`PermissionData`) requires `request_id` / `tool_name` / `description`.
 *  `.catch('')` makes these required-in-the-type yet NON-throwing: a genuine
 *  permission always carries them, and a partial entry defaults to '' rather
 *  than failing validation (which would silently drop a real pending request
 *  on the long-poll). Extra server fields (e.g. `tool_input`) are stripped. */
const PermissionEntrySchema = z.object({
  request_id: z.string().catch(''),
  tool_name: z.string().catch(''),
  description: z.string().catch(''),
  input_preview: z.string().optional(),
});

export const ProjectsPermissionsSchema = z.object({
  permissions: z.record(z.string(), PermissionEntrySchema.nullable()),
  v: z.number(),
});
export type ProjectsPermissions = z.infer<typeof ProjectsPermissionsSchema>;

/** A `/bell-state` per-project entry. `notifications` is always emitted by the
 *  server (HS-7264); the client models it optional, so required-here is fine. */
const BellStateEntrySchema = z.object({
  anyTerminalPending: z.boolean(),
  terminalIds: z.array(z.string()),
  notifications: z.record(z.string(), z.string()),
});

export const ProjectsBellStateSchema = z.object({
  bells: z.record(z.string(), BellStateEntrySchema),
  v: z.number(),
});
export type ProjectsBellState = z.infer<typeof ProjectsBellStateSchema>;

// --- §37 quit-summary ---
const QuitSummaryEntrySchema = z.object({
  terminalId: z.string(),
  label: z.string(),
  foregroundCommand: z.string(),
  isShell: z.boolean(),
  isExempt: z.boolean(),
  theme: z.string().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.number().optional(),
});

const QuitSummaryProjectSchema = z.object({
  secret: z.string(),
  name: z.string(),
  confirmMode: z.enum(['always', 'never', 'with-non-exempt-processes']),
  entries: z.array(QuitSummaryEntrySchema),
  terminalDefault: z.object({
    theme: z.string().optional(),
    fontFamily: z.string().optional(),
    fontSize: z.number().optional(),
  }).optional(),
});

export const QuitSummarySchema = z.object({ projects: z.array(QuitSummaryProjectSchema) });
export type QuitSummary = z.infer<typeof QuitSummarySchema>;

export type RegisterProjectReq = z.infer<typeof RegisterProjectSchema>;
export type ReorderProjectsReq = z.infer<typeof ReorderProjectsSchema>;

// --- Typed callers ---

/** GET `/projects` → every registered project (auto-prunes stale entries server-side). */
export async function listProjects(secret?: string): Promise<ProjectListItem[]> {
  return apiCall(z.array(ProjectListItemSchema), '/projects', { secret });
}

/** POST `/projects/register` → register a project by dataDir; returns the new project. */
export async function registerProject(dataDir: string): Promise<RegisteredProject> {
  const body: RegisterProjectReq = { dataDir };
  return apiCall(RegisteredProjectSchema, '/projects/register', { method: 'POST', body });
}

/** DELETE `/projects/:secret` → unregister a project (kills its PTYs server-side). */
export async function deleteProject(secret: string): Promise<OkResponse> {
  return apiCall(OkResponseSchema, `/projects/${encodeURIComponent(secret)}`, { method: 'DELETE' });
}

/** GET `/projects/channel-status` → channel-alive map across all projects. */
export async function getProjectsChannelStatus(): Promise<ProjectsChannelStatus> {
  return apiCall(ProjectsChannelStatusSchema, '/projects/channel-status');
}

/** GET `/projects/feedback-state` → per-project pending-feedback booleans. */
export async function getProjectsFeedbackState(): Promise<Record<string, boolean>> {
  const r = await apiCall(ProjectsFeedbackStateSchema, '/projects/feedback-state');
  return r.projects;
}

/** GET `/projects/permissions?v=` → cross-project pending-permission long-poll. */
export async function pollProjectPermissions(version: number, secret?: string): Promise<ProjectsPermissions> {
  return apiCall(ProjectsPermissionsSchema, `/projects/permissions${qs({ v: version })}`, { secret });
}

/** GET `/projects/bell-state?v=` → cross-project bell + OSC 9 long-poll. */
export async function pollBellState(version: number): Promise<ProjectsBellState> {
  return apiCall(ProjectsBellStateSchema, `/projects/bell-state${qs({ v: version })}`);
}

/** POST `/projects/:secret/reveal` → open the project folder in the OS file manager. */
export async function revealProject(secret: string): Promise<OkResponse> {
  return apiCall(OkResponseSchema, `/projects/${encodeURIComponent(secret)}/reveal`, { method: 'POST' });
}

/** POST `/projects/reorder` → persist a new project-tab order. */
export async function reorderProjects(secrets: string[]): Promise<OkResponse> {
  const body: ReorderProjectsReq = { secrets };
  return apiCall(OkResponseSchema, '/projects/reorder', { method: 'POST', body });
}

/** GET `/projects/quit-summary` → §37 quit-confirm aggregate across all projects. */
export async function getQuitSummary(): Promise<QuitSummary> {
  return apiCall(QuitSummarySchema, '/projects/quit-summary');
}
