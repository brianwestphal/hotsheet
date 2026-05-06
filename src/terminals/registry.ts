/**
 * HS-8189 — `src/terminals/registry.ts` is now a thin re-export facade
 * over the four behavioural slices under `src/terminals/registry/`. The
 * pre-fix monolith was 1006 lines / 36 exports covering attach / detach /
 * spawn / kill / destroy + bell + cwd + pid + spinner + scanner-match +
 * status. Splitting:
 *
 * - `registry/types.ts` — public types + the internal `SessionState` shape
 * - `registry/sessionStore.ts` — `sessions` Map + `sessionKey` + constants
 *   + `resolveScrollbackBytes`
 * - `registry/scannerHandler.ts` — auto-allow gate (`handleScannerMatch`,
 *   `findMatchingRuleForProject`, `buildAutoAllowAuditStrings`,
 *   `appendAutoAllowAuditEntry`, `notifyPromptWaiters`)
 * - `registry/lifecycle.ts` — PTY factory + `createSession` +
 *   `spawnIntoSession` + `teardownPty` + the destroy / kill / restart /
 *   list / env-scrub exports
 * - `registry/attach.ts` — `attach` / `detach` / `writeInput` /
 *   `resizeTerminal`
 * - `registry/state.ts` — bell / cwd / pid / spinner / scanner-match /
 *   status read-only query helpers
 *
 * Every external import (`from '../terminals/registry.js'`) keeps
 * working through this re-export — no caller-side change required.
 */

export { attach, detach, resizeTerminal, writeInput } from './registry/attach.js';
export {
  destroyAllTerminals,
  destroyProjectTerminals,
  destroyTerminal,
  ensureSpawned,
  killTerminal,
  listProjectTerminalIds,
  restartTerminal,
  scrubParentEnv,
  setPtyFactory,
  shouldStripEnvKey,
} from './registry/lifecycle.js';
export { buildAutoAllowAuditStrings } from './registry/scannerHandler.js';
export {
  clearBellPending,
  clearPendingPrompt,
  getBellPending,
  getCurrentCwd,
  getLastOutputAtMs,
  getLastSpinnerAtMs,
  getNotificationMessage,
  getTerminalPid,
  getTerminalStatus,
  listAliveTerminalsAcrossProjects,
  listBellPendingForProject,
  listPendingPromptsForProject,
  setScannerSuppressed,
  writePtyInput,
} from './registry/state.js';
export type {
  AttachOptions,
  AttachResult,
  PtyFactory,
  PtyLike,
  SpawnArgs,
  TerminalState,
  TerminalStatus,
  TerminalSubscriber,
} from './registry/types.js';
