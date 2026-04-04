import { z } from 'zod';

// --- Enums ---

export const TicketPrioritySchema = z.enum(['highest', 'high', 'default', 'low', 'lowest']);
export const TicketStatusSchema = z.enum(['not_started', 'started', 'completed', 'verified', 'backlog', 'archive', 'deleted']);
export const SortBySchema = z.enum(['created', 'priority', 'category', 'status', 'ticket_number']);
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
});

export const BatchActionSchema = z.object({
  ids: z.array(z.number().int()),
  action: z.enum(['delete', 'restore', 'category', 'priority', 'status', 'up_next']),
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
});

// --- Settings ---

export const UpdateSettingsSchema = z.record(z.string(), z.string());

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
});

// --- Projects ---

export const RegisterProjectSchema = z.object({
  dataDir: z.string().min(1, 'dataDir is required'),
});

export const ReorderProjectsSchema = z.object({
  secrets: z.array(z.string()),
});

// --- Categories ---

export const CategoryDefSchema = z.object({}).passthrough();

export const UpdateCategoriesSchema = z.array(CategoryDefSchema).min(1);

// --- Print ---

export const PrintSchema = z.object({
  html: z.string(),
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
