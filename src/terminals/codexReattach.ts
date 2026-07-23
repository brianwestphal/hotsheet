// HS-9397 (docs/123 §123.7) — detect that a LIVE codex terminal's launch command
// no longer matches what a fresh resolution would produce, and the fresh form is
// the daemon-attached one. Covers both directions: a plain-`codex` terminal whose
// project has since gained a resumable driven thread, and an attached terminal
// stranded on an old thread after a §121.5 reset. The affordance's action is a
// plain terminal restart — `restartTerminal` re-resolves on spawn, so no special
// relaunch path is needed.

import { codexTerminalAttachCommand } from '../codexAppServer.js';
import { sessionKey, sessions } from './registry/sessionStore.js';
import { resolveTerminalCommand } from './resolveCommand.js';

export interface CodexReattachDeps {
  /** Injectable for tests (and for the /list route's once-per-project value).
   *  Defaults to the real `codexTerminalAttachCommand`. */
  attachCommand?: (dataDir: string) => string | null;
  /** Injectable for tests. Defaults to the real `resolveTerminalCommand`. */
  resolve?: typeof resolveTerminalCommand;
}

/**
 * True when relaunching this terminal would join the project's driven codex
 * thread. Requires: a live PTY with a recorded launch resolution (HS-9397's
 * `resolvedCommand`, pre-shell-history-rewrite), a currently-emittable attach
 * command, and a fresh resolution that (a) differs from what the PTY launched
 * with and (b) contains that attach command — (b) scopes the signal to codex
 * attach drift, so unrelated template/config edits never light the chip.
 */
export function codexReattachAvailable(secret: string, dataDir: string, terminalId: string, deps: CodexReattachDeps = {}): boolean {
  const session = sessions.get(sessionKey(secret, terminalId));
  if (session === undefined || session.pty === null || session.resolvedCommand === null) return false;
  const attachCommand = deps.attachCommand ?? codexTerminalAttachCommand;
  const attach = attachCommand(dataDir);
  if (attach === null) return false;
  const fresh = (deps.resolve ?? resolveTerminalCommand)({
    dataDir,
    terminalId,
    configOverride: session.configOverride ?? undefined,
    codexAttachOverride: deps.attachCommand,
  }).command;
  return fresh !== session.resolvedCommand && fresh.includes(attach);
}
