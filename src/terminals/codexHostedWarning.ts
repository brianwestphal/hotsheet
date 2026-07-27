// HS-9446 (docs/129 §129.5) — notice when a codex terminal launched WITHOUT the shared
// daemon, and say so once in the Commands Log.
//
// Under model-B the terminal is supposed to own the thread the drive joins
// (`codex --remote … -C <projectDir>`). If the daemon can't be reached at spawn time,
// `codexTerminalRemoteCommand` returns null and the terminal launches plain `codex` —
// a session the drive can never discover, so driven turns quietly run in the drive's
// own off-screen thread for as long as that terminal stays open. That silence is the
// HS-9403 class, and it cost days of misdiagnosis before.
//
// This is deliberately a LOG LINE, not the retired "↻ Rejoin codex" chip: the case
// should be rare (the cold spawn awaits `ensureCodexDaemonRunning`, and the daemon is
// pre-started at project registration), so the first job is to find out whether it
// happens at all. If the log shows it does, the chip is the next step.

import { addLogEntry } from '../db/commandLog.js';
import { runWithDataDir } from '../db/connection.js';

export interface UnhostedCheck {
  /** `codexDriveDiscoverEnabled()` — the model-B toggle. */
  modelB: boolean;
  /** `isCodexAppServerEnabled()` — the drive toggle. */
  driveEnabled: boolean;
  /** The project's `ai_tool` setting, as written. */
  aiTool: string;
  /** The resolved launch command for this terminal (pre-shell-history rewrite). */
  command: string;
}

/**
 * Pure: is this a codex terminal that launched un-hosted? True only when model-B and
 * the drive are both on for a codex project AND the resolved command launches codex
 * WITHOUT `--remote`.
 *
 * The command check is what keeps this per-TERMINAL. The daemon-ensure gate
 * (`codexTerminalNeedsDaemonEnsure`) is per-project, so it also fires for a `btop`
 * terminal in a codex project — warning about that would be nonsense. Matching
 * `codex` as a whole word avoids firing on an unrelated command that merely contains
 * the substring (`codex-notes`, a path like `/x/codexy/run`).
 */
export function isUnhostedCodexLaunch(check: UnhostedCheck): boolean {
  if (!check.modelB || !check.driveEnabled) return false;
  if (check.aiTool.trim().toLowerCase() !== 'codex') return false;
  if (!/(^|\s)codex(\s|$)/.test(check.command)) return false;
  return !check.command.includes('--remote');
}

/** Terminals already warned about, keyed `${dataDir}::${terminalId}`. A restart that
 *  succeeds doesn't clear it — the entry is a record of what happened, and re-warning
 *  on every respawn of a genuinely broken daemon would flood the log. */
const warned = new Set<string>();

/** Test-only: forget the dedup state. */
export function _resetCodexHostedWarningsForTesting(): void {
  warned.clear();
}

export interface NoteUnhostedDeps {
  /** Injectable for tests. Defaults to the real Commands Log write. */
  log?: (summary: string, detail: string) => Promise<unknown>;
}

/**
 * Record the warning once per (project, terminal). Fire-and-forget: a failed log write
 * must never affect the spawn. The write is wrapped in `runWithDataDir` because a spawn
 * can happen outside any request (eager spawn at project registration), where `getDb()`
 * would otherwise fall back to the DEFAULT project and file the entry under the wrong
 * one.
 */
export function noteUnhostedCodexLaunch(dataDir: string, terminalId: string, check: UnhostedCheck, deps: NoteUnhostedDeps = {}): boolean {
  if (!isUnhostedCodexLaunch(check)) return false;
  const key = `${dataDir}::${terminalId}`;
  if (warned.has(key)) return false;
  warned.add(key);
  const write = deps.log ?? ((summary: string, detail: string) => runWithDataDir(dataDir, () => addLogEntry('trigger', 'incoming', summary, detail)));
  void Promise.resolve(write(
    `Codex terminal "${terminalId}" started without the shared daemon`,
    'This terminal launched plain `codex` because the codex app-server daemon could not be reached, '
    + 'so it does not host a thread the play button can join — driven turns will run in a separate, '
    + 'off-screen session instead of appearing here.\n\n'
    + 'Check that `codex app-server daemon start` works, then restart this terminal (the launch command '
    + 'is re-resolved on restart).',
  )).catch(() => { /* diagnostics must never break a spawn */ });
  return true;
}
