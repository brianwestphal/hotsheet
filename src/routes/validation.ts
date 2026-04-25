import { z } from 'zod';

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

export const GlobalConfigSchema = z.object({
  channelEnabled: z.boolean().optional(),
  shareTotalSeconds: z.number().optional(),
  shareLastPrompted: z.string().optional(),
  shareAccepted: z.boolean().optional(),
}).strict();

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
