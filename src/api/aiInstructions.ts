/**
 * HS-8913 — typed API for the recommended AI-assistant instruction sections
 * (`src/routes/aiInstructions.ts`). Two endpoints:
 *   - GET  `/ai-instructions/status` — is Claude detected, does CLAUDE.md exist,
 *     are the managed sections present / outdated / unfilled?
 *   - POST `/ai-instructions/apply`  — install / update the sections in CLAUDE.md.
 *
 * The section-status shapes mirror `src/aiInstructions.ts`'s `InstructionsStatus`
 * / `AiInstructionsState`; this module is the wire SSOT for the client.
 */
import { z } from 'zod';

import { apiCall } from './_runner.js';

export const SectionStatusSchema = z.object({
  id: z.string(),
  present: z.boolean(),
  version: z.number().nullable(),
  outdated: z.boolean(),
  needsSetup: z.boolean(),
});

export const AiInstructionsStateSchema = z.object({
  detected: z.boolean(),
  fileExists: z.boolean(),
  missing: z.boolean(),
  outdated: z.boolean(),
  setupNeeded: z.boolean(),
  sections: z.array(SectionStatusSchema),
});
export type AiInstructionsStateResp = z.infer<typeof AiInstructionsStateSchema>;

export const ApplyAiInstructionsRespSchema = z.object({
  written: z.boolean(),
  state: AiInstructionsStateSchema,
});
export type ApplyAiInstructionsResp = z.infer<typeof ApplyAiInstructionsRespSchema>;

/** GET `/ai-instructions/status` → install/update status for the active project. */
export async function getAiInstructionsStatus(): Promise<AiInstructionsStateResp> {
  return apiCall(AiInstructionsStateSchema, '/ai-instructions/status');
}

/** POST `/ai-instructions/apply` → write/update the managed sections in CLAUDE.md. */
export async function applyAiInstructions(): Promise<ApplyAiInstructionsResp> {
  return apiCall(ApplyAiInstructionsRespSchema, '/ai-instructions/apply', { method: 'POST' });
}
