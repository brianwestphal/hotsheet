import { z } from 'zod';

import { APPLE_FOUNDATION_MODEL_ID, LOCAL_MODEL_ID } from '../announcer/models.js';
// HS-8990 — generous per-field upper bounds (see `src/limits.ts`).
import {
  MAX_BATCH_IDS, MAX_CATEGORY_CHARS, MAX_DETAILS_CHARS, MAX_LABEL_CHARS,
  MAX_NOTES_CHARS, MAX_SEARCH_CHARS, MAX_TAGS_CHARS, MAX_TITLE_CHARS,
} from '../limits.js';

// --- Enums ---

export const TicketPrioritySchema = z.enum(['highest', 'high', 'default', 'low', 'lowest']);
export const TicketStatusSchema = z.enum(['not_started', 'started', 'completed', 'verified', 'backlog', 'archive', 'deleted']);
export const SortBySchema = z.enum(['created', 'modified', 'priority', 'category', 'status']);
export const SortDirSchema = z.enum(['asc', 'desc']);

// --- Ticket routes ---

export const CreateTicketSchema = z.object({
  title: z.string().max(MAX_TITLE_CHARS).optional().default(''),
  defaults: z.object({
    category: z.string().max(MAX_CATEGORY_CHARS).optional(),
    priority: TicketPrioritySchema.or(z.literal('')).optional(),
    status: TicketStatusSchema.or(z.literal('')).optional(),
    up_next: z.boolean().optional(),
    details: z.string().max(MAX_DETAILS_CHARS).optional(),
    tags: z.string().max(MAX_TAGS_CHARS).optional(),
  }).optional(),
});

export const UpdateTicketSchema = z.object({
  title: z.string().max(MAX_TITLE_CHARS).optional(),
  details: z.string().max(MAX_DETAILS_CHARS).optional(),
  notes: z.string().max(MAX_NOTES_CHARS).optional(),
  tags: z.string().max(MAX_TAGS_CHARS).optional(),
  category: z.string().max(MAX_CATEGORY_CHARS).optional(),
  priority: TicketPrioritySchema.optional(),
  status: TicketStatusSchema.optional(),
  up_next: z.boolean().optional(),
  last_read_at: z.string().nullable().optional(),
  // HS-9045 — worker-completed-but-not-merged flag (docs/89 §89.7).
  pending_integration: z.boolean().optional(),
  // HS-9107 — the worker branch the work landed on; nullable so it can be cleared.
  integration_branch: z.string().nullable().optional(),
});

export const BatchActionSchema = z.object({
  ids: z.array(z.number().int()).max(MAX_BATCH_IDS),
  action: z.enum(['delete', 'restore', 'category', 'priority', 'status', 'up_next', 'mark_read', 'mark_unread']),
  value: z.union([z.string().max(MAX_CATEGORY_CHARS), z.boolean()]).optional(),
});

export const DuplicateSchema = z.object({
  ids: z.array(z.number().int()).max(MAX_BATCH_IDS),
});

export const NotesEditSchema = z.object({
  text: z.string().max(MAX_NOTES_CHARS),
});

export const NotesBulkSchema = z.object({
  notes: z.string().max(MAX_NOTES_CHARS),
});

// HS-8862 — distributed-execution claim/lease request bodies (docs/90 §90.3).
export const ClaimSchema = z.object({
  worker: z.string().min(1).max(MAX_LABEL_CHARS),
  label: z.string().max(MAX_LABEL_CHARS).nullish(),
  ttlSeconds: z.number().int().positive().max(3600).optional(),
  // HS-8974 — force a reassign: take the ticket from its current holder
  // (overwrites a live foreign lease instead of returning 409). Only honored by
  // `/tickets/:id/claim`.
  force: z.boolean().optional(),
});
export const ReleaseSchema = z.object({
  worker: z.string().nullish(),
});

// HS-8865 — flat blocked_by dependency gate. Replace a ticket's blocker set.
export const BlockedBySchema = z.object({
  blockerIds: z.array(z.number().int()).max(MAX_BATCH_IDS),
});

/** HS-7599 — feedback draft create/update payload. The client builds this
 *  from the in-progress feedback dialog state and POSTs to
 *  `/api/tickets/:id/feedback-drafts`. `partitions` mirrors the dialog's
 *  working state shape: blocks (parsed at save time so future heuristic
 *  changes don't reshape the saved draft), inline responses keyed by block
 *  index, and the catch-all textarea contents. `parent_note_id` is the
 *  FEEDBACK NEEDED note that prompted the draft, or null if the parent has
 *  been deleted (free-floating draft). `prompt_text` is a snapshot of the
 *  feedback prompt so the dialog can be reconstructed even after the parent
 *  note disappears. */
export const FeedbackDraftCreateSchema = z.object({
  id: z.string().min(1),
  parent_note_id: z.union([z.string(), z.null()]),
  prompt_text: z.string(),
  partitions: z.object({
    blocks: z.array(z.object({
      markdown: z.string(),
      html: z.string(),
    })),
    inlineResponses: z.array(z.object({
      blockIndex: z.number().int(),
      text: z.string(),
    })),
    catchAll: z.string(),
  }),
});

export const FeedbackDraftUpdateSchema = z.object({
  partitions: FeedbackDraftCreateSchema.shape.partitions,
});

export const QueryTicketsSchema = z.object({
  logic: z.enum(['all', 'any']),
  conditions: z.array(z.object({
    field: z.enum(['category', 'priority', 'status', 'title', 'details', 'up_next', 'tags']),
    operator: z.enum(['equals', 'not_equals', 'contains', 'not_contains', 'lt', 'lte', 'gt', 'gte']),
    value: z.string().max(MAX_SEARCH_CHARS),
  })).max(MAX_BATCH_IDS),
  sort_by: z.string().max(MAX_CATEGORY_CHARS).optional(),
  sort_dir: SortDirSchema.optional(),
  required_tag: z.string().max(MAX_TAGS_CHARS).optional(),
  include_archived: z.boolean().optional(),
});

// --- Settings ---

export const UpdateSettingsSchema = z.record(z.string(), z.string());

/** File-settings PATCH accepts native JSON values (arrays/objects/numbers/booleans/strings).
 *  Reserved-key types are still enforced by FileSettingsSchema on read. */
export const UpdateFileSettingsSchema = z.record(z.string(), z.unknown());

// --- HS-9004 — layered (shared/local) settings writes ---

/** Which settings file a write targets (HS-9002 §2.3.1). */
export const SettingsLayerSchema = z.enum(['shared', 'local']);

/** PATCH `/file-settings/layer` — write a partial to an EXPLICIT layer
 *  (`settings.json` or `settings.local.json`), regardless of each key's default
 *  scope. Drives the dialog-wide settings scope control's Shared / Local edit modes. */
export const UpdateFileSettingsLayerSchema = z.object({
  layer: SettingsLayerSchema,
  settings: z.record(z.string(), z.unknown()),
});

/** POST `/file-settings/clear-local` — remove keys from the local layer
 *  ("Reset to shared"). */
export const ClearLocalSettingsSchema = z.object({
  keys: z.array(z.string()).min(1),
});

// --- Backups ---

export const BackupTierSchema = z.enum(['5min', 'hourly', 'daily']);

export const CreateBackupSchema = z.object({
  tier: BackupTierSchema,
});

export const RestoreBackupSchema = z.object({
  tier: z.string().min(1),
  filename: z.string().min(1),
});

// --- Shell ---

export const ShellExecSchema = z.object({
  command: z.string().min(1, 'Command cannot be empty'),
  name: z.string().optional(),
});

export const ShellKillSchema = z.object({
  id: z.number().int(),
});

// --- Channel ---

/** HS-9084 (docs/103 §103.3) — where a channel trigger is routed:
 *  - `main` (default) — the FIFO leader (today's `pickLeader` / play-button path).
 *  - `worker` — one worker's own channel server, addressed by its worktree root
 *    (matched against the registry's `worktree` marker, HS-9038 / HS-9036).
 *  - `all-workers` — broadcast to every live worker server (fire-and-forget). */
export const ChannelTriggerTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('main') }),
  z.object({ kind: z.literal('worker'), worktree: z.string().min(1).max(MAX_DETAILS_CHARS) }),
  z.object({ kind: z.literal('all-workers') }),
]);
export type ChannelTriggerTarget = z.infer<typeof ChannelTriggerTargetSchema>;

export const ChannelTriggerSchema = z.object({
  message: z.string().optional(),
  // HS-9084 — optional routing target. Omitted ⇒ main (regression-safe default).
  target: ChannelTriggerTargetSchema.optional(),
});

export const PermissionRespondSchema = z.object({
  request_id: z.string(),
  behavior: z.enum(['allow', 'deny']),
  tool_name: z.string().optional(),
  // Optional context the client already has (HS-6477) — used to populate the
  // command-log entry when the server never logged a `permission_request`
  // first (e.g. fast-respond before the long-poll's logging path ran).
  description: z.string().optional(),
  input_preview: z.string().optional(),
});

// --- Projects ---

export const RegisterProjectSchema = z.object({
  dataDir: z.string().min(1, 'dataDir is required'),
});

export const ReorderProjectsSchema = z.object({
  secrets: z.array(z.string()),
});

// --- Categories ---

export const CategoryDefSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  shortLabel: z.string().min(1),
  color: z.string().min(1),
  shortcutKey: z.string(),
  description: z.string(),
}).loose();

export const UpdateCategoriesSchema = z.array(CategoryDefSchema).min(1);

// --- Print ---

export const PrintSchema = z.object({
  html: z.string(),
});

// --- Global Config ---

// HS-8290 — terminal-dashboard settings now live globally rather than
// per-project; see docs/39-visibility-groupings.md.
export const VisibilityGroupingSchema = z.object({
  id: z.string(),
  name: z.string(),
  hiddenByProject: z.record(z.string(), z.array(z.string())),
});

export const DashboardConfigSchema = z.object({
  // HS-8292 — pre-fix this enum was `['sectioned', 'flat']`, but the
  // client emits `'flow'` (`src/client/terminalDashboard.tsx::LayoutMode`),
  // so every PATCH from the layout-toggle button was rejected as a 400 and
  // flow mode never persisted across reloads.
  layoutMode: z.enum(['sectioned', 'flow']).optional(),
  columnsPerRow: z.number().optional(),
  visibilityGroupings: z.array(VisibilityGroupingSchema).optional(),
  activeVisibilityGroupingId: z.string().optional(),
  // HS-8424 — HS-8406 added per-scope active-grouping selection on the
  // client; without it here, the `.strict()` parser rejected every
  // visibility PATCH (the client always sends both keys), so no toggle
  // made after HS-8406 landed could persist across relaunches.
  activeVisibilityGroupingIdByScope: z.record(z.string(), z.string()).optional(),
}).strict();

// HS-8751 — global API-key registry. Key *metadata* (id, type, name) lives in
// `~/.hotsheet/config.json` (machine-global, shared across every project); the
// secret *value* lives in the OS keychain keyed by `id` (never in config / git).
// A project selects a key by id (per-project `announcer_ai_key_id` setting),
// defaulting to the first key of the matching type. See docs/79-api-keys.md.
// HS-8763 — Google Cloud TTS was registerable but had no consumer; support is
// dropped "for now", leaving a single key type. Re-adding a type is a one-line
// change to this enum + the client label map (`keysSettings.tsx`).
export const KeyTypeSchema = z.enum(['anthropic_api_key']);
export type KeyType = z.infer<typeof KeyTypeSchema>;

export const SecretKeyMetaSchema = z.object({
  id: z.string(),
  type: KeyTypeSchema,
  name: z.string(),
  // HS-8760 — provenance shown in the API Keys row ("Created/Updated …").
  // Optional for back-compat with keys created before HS-8760.
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type SecretKeyMeta = z.infer<typeof SecretKeyMetaSchema>;

export const GlobalConfigSchema = z.object({
  channelEnabled: z.boolean().optional(),
  shareTotalSeconds: z.number().optional(),
  shareLastPrompted: z.string().optional(),
  shareAccepted: z.boolean().optional(),
  dashboard: DashboardConfigSchema.optional(),
  diagnosticsEnabled: z.boolean().optional(),
  // HS-7940 — opt-in non-localhost serving (docs/46 §46.5). `bind` is the
  // interface the HTTP server listens on (default `127.0.0.1`; `0.0.0.0` or a
  // specific IP to expose off-box); a `--bind` CLI arg overrides it.
  // `trustedOrigins` is the allow-list of non-localhost Origins/Referers (host,
  // IP, full origin URL, IPv4 CIDR, or the keyword `tailscale`) that may reach
  // the API + do same-origin mutations without the secret on an exposed server.
  bind: z.string().optional(),
  trustedOrigins: z.array(z.string()).optional(),
  // HS-8993 — extra hostnames/IPs to embed as SANs in the mTLS server cert
  // (§94). Needed when `bind` is a wildcard (`0.0.0.0`) so the cert covers the
  // actual address clients connect to; loopback + a concrete `bind` + plain
  // host/IP `trustedOrigins` entries are included automatically.
  tlsServerHosts: z.array(z.string()).optional(),
  // HS-8488 — "use software rendering for terminals" opt-out. See
  // `global-config.ts` for the contract.
  terminalWebglOptOut: z.boolean().optional(),
  // HS-8497 — billing model for telemetry cost display. See
  // `global-config.ts` for the contract.
  telemetryCostMode: z.enum(['api', 'subscription']).optional(),
  // HS-8751 — global API-key registry (metadata only; values in the keychain).
  keys: z.array(SecretKeyMetaSchema).optional(),
  // HS-8754 — Announcer playback speed multiplier (1 = normal). Global because
  // it's a listening preference, not project-specific. Clamped 0.5×–2×.
  announcerSpeechRate: z.number().min(0.5).max(2).optional(),
  // HS-8764 — Announcer summarization model. Global; defaults to the cheapest
  // (Haiku) when unset. See `src/announcer/models.ts`. HS-8853 — the Anthropic
  // list is now discovered dynamically from the user's key, so this accepts any
  // `claude-*` id (not just the static set) plus the two on-device pseudo-ids.
  announcerModel: z.string()
    .refine(v => v === APPLE_FOUNDATION_MODEL_ID || v === LOCAL_MODEL_ID || v.startsWith('claude-'),
      { message: 'must be an on-device provider id or a claude-* model id' })
    .optional(),
  // HS-8792 — local-provider config (used only when `announcerModel === 'local'`).
  // `Endpoint` is the OpenAI-compatible base URL (default `http://localhost:11434/v1`);
  // `Model` is the concrete local model name (e.g. `llama3.1`). Both global.
  announcerLocalEndpoint: z.string().optional(),
  announcerLocalModel: z.string().optional(),
  // HS-8891 — optional fallback model used ONLY when the primary is Apple
  // Foundation Models and it fails at inference (the HS-8883 "code 4" class). A
  // non-apple id: a `claude-*` model (cloud backup, spends on the user's key) or
  // the local pseudo-id. Empty string / unset = no fallback (Apple failure → no
  // narration, the pre-HS-8891 behavior). The auto-selected-on-device fallback
  // (HS-8805) is separate and unaffected.
  announcerFallbackModel: z.string()
    .refine(v => v === '' || v === LOCAL_MODEL_ID || v.startsWith('claude-'),
      { message: 'must be empty, the local provider id, or a claude-* model id' })
    .optional(),
  // HS-8781 — verbally announce permission checks (TTS only, no API cost).
  // Global; default ON, so `undefined`/unset is treated as enabled by the
  // client (`announcerSpeakPermissions !== false`).
  announcerSpeakPermissions: z.boolean().optional(),
  // HS-8874 — one-time marker that the per-project telemetry migration
  // (`migratePerProjectTelemetry`) has run. Set after a successful, non-
  // destructive copy of legacy launch-default telemetry rows into each row's
  // owning project DB / the central store. Skipped on subsequent startups.
  telemetryMigratedV1: z.boolean().optional(),
  // HS-8874 (migration efficiency) — per-source-DB resumability for the
  // telemetry migration. Each source project dir is appended here once all its
  // foreign rows have been copied, so a crash/quit mid-migration resumes at the
  // first incomplete DB instead of restarting from zero (the boot-loop the
  // end-only `telemetryMigratedV1` flag caused). Cleared when migration completes.
  telemetryMigrationV1DoneDirs: z.array(z.string()).optional(),
  // HS-9231 (epic HS-9226 Phase 1) — one-shot relocation of each project's
  // telemetry tables out of its snapshotted `<dataDir>/db` into the separate
  // `<dataDir>/telemetry/db` cluster. `telemetryRelocatedV1` is the completion
  // flag; `telemetryRelocationV1DoneDirs` is the per-project resumability list
  // (same pattern as the HS-8874 migration above), cleared on completion.
  telemetryRelocatedV1: z.boolean().optional(),
  telemetryRelocationV1DoneDirs: z.array(z.string()).optional(),
  // HS-8877 — retention window (days) for the centralized non-project telemetry
  // store (`~/.hotsheet/telemetry`). Projects have a per-project
  // `telemetry_retention_days`; central isn't a project, so its sweep window
  // lives here. Unset → the §67.6 default (30 days). `0` keeps central forever.
  centralTelemetryRetentionDays: z.number().int().min(0).optional(),
  // HS-8890 (§85.2.2) — retention window (days) for `otel_spans` in the central
  // store. Spans (§68 enhanced tracing) are high-volume, so they age out faster
  // than metrics/events: unset → the §85 default of 7 days (vs 30 for
  // metrics/events via `centralTelemetryRetentionDays`); `0` keeps spans forever.
  centralSpanRetentionDays: z.number().int().min(0).optional(),
  // HS-8884 — last time a `VACUUM FULL` reclaim ran per telemetry DB dir
  // (`<dataDir>/db` or the central store), keyed by that dir's absolute path →
  // ISO timestamp. Throttles the heavy, exclusive-lock full reclaim to at most
  // once per `FULL_VACUUM_THROTTLE_DAYS`; routine plain VACUUMs aren't tracked.
  telemetryVacuumFullAt: z.record(z.string(), z.string()).optional(),
}).strict();

// HS-8635 — these were duplicated verbatim in `src/global-config.ts`; that
// module now imports them from here so there's ONE definition. `validation.ts`
// is client-safe (zod-only), so the server storage module + the typed API
// layer (`src/api/settings.ts`) + the client all share these.
export type VisibilityGroupingPersisted = z.infer<typeof VisibilityGroupingSchema>;
export type DashboardConfig = z.infer<typeof DashboardConfigSchema>;
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

// --- Plugin routes ---

export const PluginActionSchema = z.object({
  actionId: z.string(),
  ticketIds: z.array(z.number().int()).optional(),
  value: z.unknown().optional(),
});

export const PluginValidateSchema = z.object({
  key: z.string(),
  value: z.string(),
});

export const PluginSyncScheduleSchema = z.object({
  interval_minutes: z.number().nullable(),
});

export const PluginConflictResolveSchema = z.object({
  plugin_id: z.string().min(1, 'plugin_id is required'),
  resolution: z.enum(['keep_local', 'keep_remote']),
});

export const PluginInstallSchema = z.object({
  path: z.string().min(1, 'path is required'),
});

export const PluginGlobalConfigSchema = z.object({
  key: z.string().min(1, 'key is required'),
  value: z.string(),
});

export const ChannelHeartbeatSchema = z.object({
  projectDir: z.string().optional(),
  state: z.enum(['busy', 'idle', 'heartbeat']).optional(),
});

// --- Helper ---

/** Parse request body with a Zod schema, returning 400 on validation failure. */
export function parseBody<T>(schema: z.ZodType<T>, data: unknown): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(data);
  if (!result.success) {
    const messages = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).filter(m => m !== ': ');
    return { success: false, error: messages.join('; ') || 'Invalid request body' };
  }
  return { success: true, data: result.data };
}
