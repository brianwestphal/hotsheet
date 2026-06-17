/**
 * HS-8630 (HS-8522 typed-API layer) — typed callers + wire SSOT for the
 * terminal domain's JSON endpoints (`src/routes/terminal.ts`). The WebSocket
 * attach handler is NOT JSON and stays a bespoke handler — out of scope.
 *
 * Endpoints:
 *   - `GET  /terminal/list`                  → TerminalList (configured + dynamic + home)
 *   - `GET  /terminal/status?terminalId=`    → TerminalStatus
 *   - `GET  /terminal/foreground-process?…`  → ForegroundProcess
 *   - `GET  /terminal/command-suggestions`   → string array
 *   - `POST /terminal/restart`               → ok        (body: terminalId?)
 *   - `POST /terminal/kill`                  → ok        (body: signal?, terminalId?)
 *   - `POST /terminal/create`                → config    (body: name?, command?, cwd?, spawn?)
 *   - `POST /terminal/destroy`               → ok        (body: terminalId?)
 *   - `POST /terminal/clear-bell`            → ok        (body: terminalId?)
 *   - `POST /terminal/open-cwd`              → ok        (body: path)
 *
 * `TerminalState` / `TerminalStatus` / `TerminalConfig` are reclaimed here as
 * the single source of truth (previously declared in `src/terminals/config.ts`
 * + `src/terminals/registry/types.ts`, which now re-export the inferred types
 * — same move `git.ts` made for `GitStatus`).
 *
 * Several call sites are cross-project (the dashboard / channel UI operate on
 * other projects' terminals); every caller therefore takes an optional
 * `secret` that forwards to `apiCall`'s `opts.secret` (→ `apiWithSecret`).
 */
import { z } from 'zod';

import { apiCall, type OkResponse, OkResponseSchema, qs } from './_runner.js';

/** PTY lifecycle state. */
export const TerminalStateSchema = z.enum(['alive', 'exited', 'not_spawned']);
export type TerminalState = z.infer<typeof TerminalStateSchema>;

/** A terminal's persisted (or dynamic) config. SSOT — `src/terminals/config.ts`
 *  re-exports this. `command` may contain the `{{claudeCommand}}` template;
 *  the appearance fields fall back to the project default then a hard-coded one. */
export const TerminalConfigSchema = z.object({
  id: z.string(),
  /** Tab label; defaults to `default-<index>` or the command's first word. */
  name: z.string().optional(),
  command: z.string(),
  /** Working-directory override; blank/unset = project root. */
  cwd: z.string().optional(),
  /** When true (default), PTY spawns on first WebSocket attach; false = eager. */
  lazy: z.boolean().optional(),
  theme: z.string().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.number().optional(),
});
export type TerminalConfig = z.infer<typeof TerminalConfigSchema>;

/** Cheap status lookup (no PTY spawn). SSOT — `registry/types.ts` re-exports. */
export const TerminalStatusSchema = z.object({
  state: TerminalStateSchema,
  startedAt: z.number().nullable(),
  command: z.string().nullable(),
  exitCode: z.number().nullable(),
  cols: z.number(),
  rows: z.number(),
  scrollbackBytes: z.number(),
});
export type TerminalStatus = z.infer<typeof TerminalStatusSchema>;

/** A `/list` entry — a config annotated with the server-side runtime flags the
 *  drawer + dashboard seed their indicators from (bell / OSC 9 notification /
 *  OSC 7 cwd / lifecycle state / Claude spinner + output timestamps). The
 *  server always emits every annotation, but they're modeled `.optional()` to
 *  match the client's own `ListEntry` / `TerminalListEntry` shapes (which have
 *  always treated them as optional + defaulted with `?? null` / `?? false`). */
export const AnnotatedTerminalSchema = TerminalConfigSchema.extend({
  bellPending: z.boolean().optional(),
  notificationMessage: z.string().nullable().optional(),
  currentCwd: z.string().nullable().optional(),
  state: TerminalStateSchema.optional(),
  exitCode: z.number().nullable().optional(),
  lastSpinnerAtMs: z.number().nullable().optional(),
  lastOutputAtMs: z.number().nullable().optional(),
});
export type AnnotatedTerminal = z.infer<typeof AnnotatedTerminalSchema>;

/** `GET /terminal/list` body. `home` is the server's resolved `$HOME` so the
 *  §29 cwd chip can tildify paths on the first tick. */
export const TerminalListSchema = z.object({
  configured: z.array(AnnotatedTerminalSchema),
  dynamic: z.array(AnnotatedTerminalSchema),
  home: z.string(),
});
export type TerminalList = z.infer<typeof TerminalListSchema>;

/** `GET /terminal/foreground-process` body (§37.6 quit-confirm). */
export const ForegroundProcessSchema = z.object({
  command: z.string(),
  isShell: z.boolean(),
  isExempt: z.boolean(),
  error: z.string().optional(),
});
export type ForegroundProcess = z.infer<typeof ForegroundProcessSchema>;

const CreateTerminalRespSchema = z.object({ config: TerminalConfigSchema });
const CommandSuggestionsSchema = z.object({ suggestions: z.array(z.string()) });

// --- Request body schemas (server-validatable; client caller inputs) ---

/** `POST /terminal/create` body. All optional — an empty body launches the
 *  user's default shell lazily. `.loose()` tolerates unexpected extra keys. */
export const CreateTerminalReqSchema = z.object({
  name: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  spawn: z.boolean().optional(),
  // HS-8539 — when set, the terminal launches the DEFAULT shell (NOT this as the
  // PTY command) and the server writes `runCommand\n` into the PTY so it runs as
  // if typed, leaving the shell open afterward. Powers the long-press "run in a
  // new terminal" path on custom shell-command buttons.
  runCommand: z.string().optional(),
}).loose();
export type CreateTerminalReq = z.infer<typeof CreateTerminalReqSchema>;

/** `POST /terminal/open-cwd` body. `path` optional so the server's
 *  "missing path" 400 branch still fires when absent. */
export const OpenTerminalCwdReqSchema = z.object({ path: z.string().optional() }).loose();
export type OpenTerminalCwdReq = z.infer<typeof OpenTerminalCwdReqSchema>;

// --- Typed callers ---

/** GET `/terminal/list` → the project's attachable terminals + runtime flags. */
export async function listTerminals(secret?: string): Promise<TerminalList> {
  return apiCall(TerminalListSchema, '/terminal/list', { secret });
}

/** GET `/terminal/status?terminalId=` → cheap status, no spawn. */
export async function getTerminalStatus(terminalId: string, secret?: string): Promise<TerminalStatus> {
  return apiCall(TerminalStatusSchema, `/terminal/status${qs({ terminalId })}`, { secret });
}

/** GET `/terminal/foreground-process?terminalId=` → foreground child info. */
export async function getForegroundProcess(terminalId: string, secret?: string): Promise<ForegroundProcess> {
  return apiCall(ForegroundProcessSchema, `/terminal/foreground-process${qs({ terminalId })}`, { secret });
}

/** GET `/terminal/command-suggestions` → command combobox suggestions. */
export async function getCommandSuggestions(): Promise<string[]> {
  const r = await apiCall(CommandSuggestionsSchema, '/terminal/command-suggestions');
  return r.suggestions;
}

/** POST `/terminal/restart` → kill + respawn the PTY. */
export async function restartTerminal(terminalId: string, secret?: string): Promise<OkResponse> {
  return apiCall(OkResponseSchema, '/terminal/restart', { method: 'POST', body: { terminalId }, secret });
}

/** POST `/terminal/kill` → kill the PTY without restart (default SIGHUP). */
export async function killTerminal(terminalId: string, signal?: string, secret?: string): Promise<OkResponse> {
  return apiCall(OkResponseSchema, '/terminal/kill', { method: 'POST', body: { terminalId, signal }, secret });
}

/** POST `/terminal/create` → register a dynamic terminal; returns its config. */
export async function createTerminal(body: CreateTerminalReq = {}, secret?: string): Promise<{ config: TerminalConfig }> {
  return apiCall(CreateTerminalRespSchema, '/terminal/create', { method: 'POST', body, secret });
}

/** POST `/terminal/destroy` → fully remove a session + its dynamic config. */
export async function destroyTerminal(terminalId: string, secret?: string): Promise<OkResponse> {
  return apiCall(OkResponseSchema, '/terminal/destroy', { method: 'POST', body: { terminalId }, secret });
}

/** POST `/terminal/clear-bell` → drop the server-side bell-pending flag. */
export async function clearTerminalBell(terminalId: string, secret?: string): Promise<OkResponse> {
  return apiCall(OkResponseSchema, '/terminal/clear-bell', { method: 'POST', body: { terminalId }, secret });
}

/** POST `/terminal/open-cwd` → open a path in the OS file manager (§29). */
export async function openTerminalCwd(path: string, secret?: string): Promise<OkResponse> {
  return apiCall(OkResponseSchema, '/terminal/open-cwd', { method: 'POST', body: { path }, secret });
}
