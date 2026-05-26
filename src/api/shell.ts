/**
 * HS-8638 (HS-8522 closeout) — typed callers + wire schemas for the shell
 * command-execution domain (`src/routes/shell.ts`, §15 / §53): run a custom
 * Shell-target command, kill a running one, and poll the running set + live
 * partial output. The streaming WebSocket-less design polls `/shell/running`
 * (the §53 partial-output buffer rides along on `outputs`).
 */
import { z } from 'zod';

import { type ShellExecSchema, type ShellKillSchema } from '../routes/validation.js';
import { apiCall, type OkResponse, OkResponseSchema } from './_runner.js';

/** `GET /shell/running` → ids of in-flight shell commands + their partial
 *  output buffers (§53; head-truncated, 4 MB cap server-side). */
export const RunningShellSchema = z.object({
  ids: z.array(z.number()),
  outputs: z.record(z.string(), z.string()),
});
export type RunningShell = z.infer<typeof RunningShellSchema>;

const ShellExecResultSchema = z.object({ id: z.number() });

export type ShellExecReq = z.infer<typeof ShellExecSchema>;
export type ShellKillReq = z.infer<typeof ShellKillSchema>;

// --- Typed callers ---

/** GET `/shell/running` → running command ids + live partial output. */
export async function getRunningShellCommands(): Promise<RunningShell> {
  return apiCall(RunningShellSchema, '/shell/running');
}

/** POST `/shell/exec` → start a shell command; returns the new command-log id. */
export async function execShellCommand(command: string, name?: string): Promise<{ id: number }> {
  const body: ShellExecReq = { command, ...(name !== undefined ? { name } : {}) };
  return apiCall(ShellExecResultSchema, '/shell/exec', { method: 'POST', body });
}

/** POST `/shell/kill` → terminate a running shell command by its log id. */
export async function killShellCommand(id: number): Promise<OkResponse> {
  const body: ShellKillReq = { id };
  return apiCall(OkResponseSchema, '/shell/kill', { method: 'POST', body });
}
