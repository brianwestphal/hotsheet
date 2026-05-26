// HS-8567 — shared zod schemas for runtime validation of data that crosses
// a type boundary (wire, file, DB JSON column). Schemas defined here are
// importable from both server and client code, so the same shape is
// enforced on every end of every channel.
//
// Server-only HTTP request-body schemas live in `src/routes/validation.ts`.
// Anything that needs to be parsed on the client (response payloads, DB
// JSON columns rendered to the user) belongs here.
//
// Rule of thumb: if you find yourself writing `JSON.parse(x) as Foo`,
// `await res.json() as Foo`, or `obj as Foo` for data sourced from
// outside your function, add a schema here and parse instead.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Ticket notes — `tickets.notes` is a JSON-encoded array of note records.
// HS-8427 normalized the shape; the defensive unwrap in the server tolerates
// a few legacy variants but new writes always use this shape.
// ---------------------------------------------------------------------------

export const NoteEntrySchema = z.object({
  id: z.string(),
  text: z.string(),
  created_at: z.string(),
}).loose();

export const NotesArraySchema = z.array(NoteEntrySchema);

export type NoteEntry = z.infer<typeof NoteEntrySchema>;

// ---------------------------------------------------------------------------
// Ticket — HS-8629 (HS-8522 typed-API layer). The single source of truth for
// the core domain row shape, shared by the server (`src/types.ts` re-exports
// `Ticket` from here) AND the client typed API callers (`src/api/tickets.ts`
// builds its response schemas on this). The priority / status literals are
// inlined (rather than imported from `src/types.ts` or `src/routes/
// validation.ts`) so this module stays import-free beyond zod — `types.ts`
// imports THIS, so importing types.ts back would cycle, and `routes/` is
// server-only. `category` is a free string (user-defined categories).
// ---------------------------------------------------------------------------

export const TicketSchema = z.object({
  id: z.number(),
  ticket_number: z.string(),
  title: z.string(),
  details: z.string(),
  category: z.string(),
  priority: z.enum(['highest', 'high', 'default', 'low', 'lowest']),
  status: z.enum(['not_started', 'started', 'completed', 'verified', 'backlog', 'archive', 'deleted']),
  up_next: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
  verified_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
  notes: z.string(),
  tags: z.string(),
  last_read_at: z.string().nullable(),
});

export type Ticket = z.infer<typeof TicketSchema>;

// ---------------------------------------------------------------------------
// Ticket tags — `tickets.tags` is a JSON-encoded string array.
// ---------------------------------------------------------------------------

export const TagsArraySchema = z.array(z.string());

// ---------------------------------------------------------------------------
// Category definitions — `settings.categories` row. Same shape as
// `CategoryDefSchema` in `src/routes/validation.ts` but re-declared here so
// the client can import without reaching into `routes/`.
// ---------------------------------------------------------------------------

export const CategoryDefSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  shortLabel: z.string().min(1),
  color: z.string().min(1),
  shortcutKey: z.string(),
  description: z.string(),
}).loose();

export const CategoryDefArraySchema = z.array(CategoryDefSchema);

// ---------------------------------------------------------------------------
// Daily-stats snapshot — `daily_stats.data` JSON column.
// Counts per status; shape is open-ended so we accept any numeric record.
// ---------------------------------------------------------------------------

export const SnapshotDataSchema = z.record(z.string(), z.number());

export type SnapshotData = z.infer<typeof SnapshotDataSchema>;

// ---------------------------------------------------------------------------
// Channel port file — `.hotsheet/channel.port.json`. Written by the channel
// server on startup; read by the main server to know where to forward
// permission prompts.
// ---------------------------------------------------------------------------

export const ChannelPortFileSchema = z.object({
  port: z.number().int().positive(),
  secret: z.string().min(1),
}).loose();

// ---------------------------------------------------------------------------
// Hot Sheet settings file — `<dataDir>/settings.json`. Used by the channel
// MCP-tools layer to discover the local API port + secret.
// ---------------------------------------------------------------------------

export const HotsheetSettingsSchema = z.object({
  port: z.number().int().positive().optional(),
  secret: z.string().min(1).optional(),
}).loose();

// ---------------------------------------------------------------------------
// Plugin tags column — `tickets.tags` viewed from the sync engine. Tolerates
// empty / null shapes by defaulting upstream of the parse.
// ---------------------------------------------------------------------------

export const PluginTagsSchema = z.array(z.string());

// ---------------------------------------------------------------------------
// Plugin sync conflict data — `sync_records.conflict_data` JSON column.
// ---------------------------------------------------------------------------

export const PluginConflictDataSchema = z.object({
  local: z.record(z.string(), z.unknown()).optional(),
  remote: z.record(z.string(), z.unknown()).optional(),
  fields: z.array(z.string()).optional(),
}).loose();

// ---------------------------------------------------------------------------
// Wire-error body — what every API call gets back when `res.ok === false`.
// Used by `src/client/api.tsx` to surface a server error message to the
// user-visible network-error popup.
// ---------------------------------------------------------------------------

export const ErrorBodySchema = z.object({
  error: z.string().optional(),
}).loose();

// ---------------------------------------------------------------------------
// Channel health-check body — `GET /api/channel/health` on the channel
// server (responded to by the main server's proxy in some paths).
// ---------------------------------------------------------------------------

export const ChannelOkBodySchema = z.object({
  ok: z.boolean(),
  version: z.number().int().optional(),
}).loose();

// ---------------------------------------------------------------------------
// GitHub releases response shape — the upgrade-nudge fetch.
// ---------------------------------------------------------------------------

export const GithubReleaseSchema = z.object({
  assets: z.array(z.object({
    name: z.string(),
    browser_download_url: z.string(),
  }).loose()).optional(),
}).loose();

// ---------------------------------------------------------------------------
// Package.json version — used by `src/update-check.ts` for both the local
// package read and the npm registry response.
// ---------------------------------------------------------------------------

export const PackageVersionSchema = z.object({
  version: z.string(),
}).loose();

// ---------------------------------------------------------------------------
// CLI summary / close-flow response shapes (used by `src/cli/close.ts`).
// ---------------------------------------------------------------------------

export const ProjectListItemSchema = z.object({
  name: z.string(),
  dataDir: z.string(),
  ticketCount: z.number().int(),
}).loose();

export const ProjectRegistrationSchema = z.object({
  name: z.string(),
  secret: z.string(),
}).loose();

export const ProjectNameOnlySchema = z.object({
  name: z.string(),
}).loose();

// ---------------------------------------------------------------------------
// Permission proxy — `POST /api/channel/permissions/pending` response shape
// (channel → main server outbound).
// ---------------------------------------------------------------------------

// Channel-server fields are individually optional; not every permission
// request carries every field, and tolerating the partial shape matches
// what the type alias in `src/routes/channel.ts` already does.
export const PendingPermissionEntrySchema = z.object({
  request_id: z.string().optional(),
  tool_name: z.string().optional(),
  description: z.string().optional(),
  input_preview: z.string().optional(),
  tool_input: z.unknown().optional(),
}).loose();

export const PendingPermissionSchema = z.object({
  pending: PendingPermissionEntrySchema.nullable(),
}).loose();

// ---------------------------------------------------------------------------
// Permission decision result — channel server outbound.
// ---------------------------------------------------------------------------

export const PermissionResultBodySchema = z.object({
  decision: z.enum(['allow', 'deny']).optional(),
  updatedInput: z.unknown().optional(),
}).loose();

// ---------------------------------------------------------------------------
// GitHub plugin issue-comments body fragment.
// ---------------------------------------------------------------------------

export const GithubCommentsArraySchema = z.array(z.object({
  body_html: z.string().optional(),
}).loose());

// ---------------------------------------------------------------------------
// Helper: parse a JSON string with a zod schema, throwing a clear error.
// Centralizes the JSON.parse + schema.parse two-step that replaces every
// `JSON.parse(x) as Foo` callsite.
// ---------------------------------------------------------------------------

export function parseJson<T>(schema: z.ZodType<T>, json: string, context?: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`parseJson${context !== undefined ? ` (${context})` : ''}: invalid JSON — ${msg}`);
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`parseJson${context !== undefined ? ` (${context})` : ''}: ${issues}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Helper: parse a JSON string with a zod schema, returning `null` on any
// failure (parse error OR validation error). For callsites that already
// tolerate / want to ignore malformed input rather than surface it.
// ---------------------------------------------------------------------------

export function parseJsonOrNull<T>(schema: z.ZodType<T>, json: string | null | undefined): T | null {
  if (json === null || json === undefined || json === '') return null;
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return null; }
  const result = schema.safeParse(raw);
  return result.success ? result.data : null;
}
