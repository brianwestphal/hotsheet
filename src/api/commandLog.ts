/**
 * HS-8638 (HS-8522 closeout) — typed callers + wire schema for the commands-log
 * domain (`src/routes/commandLog.ts`, §14): the Claude-channel + shell command
 * history viewer.
 *
 * `CommandLogEntrySchema` is the wire SSOT for a log row. The client decorates
 * it into `AnnotatedEntry` (adds `isRunningShell`) AFTER fetching — that's a
 * view-model concern, not part of the wire shape, so it lives in
 * `commandLogStore.ts`.
 */
import { z } from 'zod';

import { apiCall, type OkResponse, OkResponseSchema, qs } from './_runner.js';

/** A single command-log row as the server returns it. */
export const CommandLogEntrySchema = z.object({
  id: z.number(),
  event_type: z.string(),
  direction: z.string(),
  summary: z.string(),
  detail: z.string(),
  created_at: z.string(),
});
export type CommandLogEntry = z.infer<typeof CommandLogEntrySchema>;

const CommandLogCountSchema = z.object({ count: z.number() });

/** Filters for `GET /command-log`. */
export interface CommandLogQuery {
  limit?: number;
  offset?: number;
  event_type?: string;
  search?: string;
}

// --- Typed callers ---

/** GET `/command-log` → recent log rows (newest first), optionally filtered. */
export async function getCommandLog(query: CommandLogQuery = {}): Promise<CommandLogEntry[]> {
  return apiCall(z.array(CommandLogEntrySchema), `/command-log${qs({ ...query })}`);
}

/** DELETE `/command-log` → clear the entire log for the active project. */
export async function clearCommandLog(): Promise<OkResponse> {
  return apiCall(OkResponseSchema, '/command-log', { method: 'DELETE' });
}

/** GET `/command-log/count` → total rows matching the filter (for pagination). */
export async function getCommandLogCount(query: Pick<CommandLogQuery, 'event_type' | 'search'> = {}): Promise<number> {
  const r = await apiCall(CommandLogCountSchema, `/command-log/count${qs({ ...query })}`);
  return r.count;
}
