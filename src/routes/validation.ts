import { z } from 'zod';

import { ANNOUNCER_MODEL_IDS } from '../announcer/models.js';

// --- Enums ---

export const TicketPrioritySchema = z.enum(['highest', 'high', 'default', 'low', 'lowest']);
export const TicketStatusSchema = z.enum(['not_started', 'started', 'completed', 'verified', 'backlog', 'archive', 'deleted']);
export const SortBySchema = z.enum(['created', 'modified', 'priority', 'category', 'status']);
export const SortDirSchema = z.enum(['asc', 'desc']);

// --- Ticket routes ---

export const CreateTicketSchema = z.object({
  title: z.string().optional().default(''),
  defaults: z.object({
    category: z.string().optional(),
    priority: TicketPrioritySchema.or(z.literal('')).optional(),
    status: TicketStatusSchema.or(z.literal('')).optional(),
    up_next: z.boolean().optional(),
    details: z.string().optional(),
    tags: z.string().optional(),
  }).optional(),
});

export const UpdateTicketSchema = z.object({
  title: z.string().optional(),
  details: z.string().optional(),
  notes: z.string().optional(),
  tags: z.string().optional(),
  category: z.string().optional(),
  priority: TicketPrioritySchema.optional(),
  status: TicketStatusSchema.optional(),
  up_next: z.boolean().optional(),
  last_read_at: z.string().nullable().optional(),
});

export const BatchActionSchema = z.object({
  ids: z.array(z.number().int()),
  action: z.enum(['delete', 'restore', 'category', 'priority', 'status', 'up_next', 'mark_read', 'mark_unread']),
  value: z.union([z.string(), z.boolean()]).optional(),
});

export const DuplicateSchema = z.object({
  ids: z.array(z.number().int()),
});

export const NotesEditSchema = z.object({
  text: z.string(),
});

export const NotesBulkSchema = z.object({
  notes: z.string(),
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
    value: z.string(),
  })),
  sort_by: z.string().optional(),
  sort_dir: SortDirSchema.optional(),
  required_tag: z.string().optional(),
  include_archived: z.boolean().optional(),
});

// --- Settings ---

export const UpdateSettingsSchema = z.record(z.string(), z.string());

/** File-settings PATCH accepts native JSON values (arrays/objects/numbers/booleans/strings).
 *  Reserved-key types are still enforced by FileSettingsSchema on read. */
export const UpdateFileSettingsSchema = z.record(z.string(), z.unknown());

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

export const ChannelTriggerSchema = z.object({
  message: z.string().optional(),
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
  // (Haiku) when unset. See `src/announcer/models.ts`.
  announcerModel: z.enum(ANNOUNCER_MODEL_IDS).optional(),
  // HS-8781 — verbally announce permission checks (TTS only, no API cost).
  // Global; default ON, so `undefined`/unset is treated as enabled by the
  // client (`announcerSpeakPermissions !== false`).
  announcerSpeakPermissions: z.boolean().optional(),
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
