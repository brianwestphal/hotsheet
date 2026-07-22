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

// HS-8916 — per-tool managed-instructions state. Added to the status + apply
// responses so the UI can show which tools got their instruction files written.
//
// HS-9366 — the SINGLE source of truth for the instruction-tool id list, shared
// with the server's `AiInstructionTool` type (`src/aiInstructionsTools.ts`
// derives from it). The enum previously listed only the original four tools, so
// when the server's TOOLS table gained `antigravity` (HS-9322) + `opencode`
// (HS-9344) every `/ai-instructions/status` response FAILED validation — the
// §86 nudge/silent-update path was silently dead (its catch swallowed the
// mismatch). Deriving the server type from this list makes that drift a
// compile-time error instead.
export const AI_INSTRUCTION_TOOLS = ['claude', 'cursor', 'windsurf', 'copilot', 'antigravity', 'opencode', 'codex'] as const;

export const ToolInstructionsStateSchema = z.object({
  tool: z.enum(AI_INSTRUCTION_TOOLS),
  label: z.string(),
  detected: z.boolean(),
  fileExists: z.boolean(),
  missing: z.boolean(),
  outdated: z.boolean(),
  setupNeeded: z.boolean(),
  sections: z.array(SectionStatusSchema),
});
export type ToolInstructionsStateResp = z.infer<typeof ToolInstructionsStateSchema>;

export const AiInstructionsStateSchema = z.object({
  detected: z.boolean(),
  fileExists: z.boolean(),
  missing: z.boolean(),
  outdated: z.boolean(),
  setupNeeded: z.boolean(),
  sections: z.array(SectionStatusSchema),
  // HS-8916 — per-tool states (optional; the status/apply routes populate it).
  tools: z.array(ToolInstructionsStateSchema).optional(),
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
