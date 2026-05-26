/**
 * HS-8638 (HS-8522 closeout) — typed caller for the client-side freeze
 * reporter (`POST /diagnostics/freeze`, `src/routes/diagnostics.ts`). The
 * client posts a freeze record (the §8 longtask observer / heartbeat /
 * slow-server banner) which the server appends to `<dataDir>/freeze.log`.
 * Server-only freeze sources never hit this route, so the request type is the
 * client-sendable subset.
 */
import { z } from 'zod';

import { apiCall, type OkResponse, OkResponseSchema } from './_runner.js';

/** The client-sendable freeze record. Server-side `coerceFreezeEntry` is
 *  lenient; this captures what the three client reporters actually emit. */
export const ClientFreezeReportSchema = z.object({
  ts: z.string(),
  source: z.enum(['client-observer', 'client-heartbeat', 'client-server-busy-banner']),
  durationMs: z.number(),
  context: z.string(),
  clientWallClock: z.string().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type ClientFreezeReport = z.infer<typeof ClientFreezeReportSchema>;

/** POST `/diagnostics/freeze` → append a client freeze record to `freeze.log`. */
export async function reportClientFreeze(report: ClientFreezeReport): Promise<OkResponse> {
  return apiCall(OkResponseSchema, '/diagnostics/freeze', { method: 'POST', body: report });
}
