// HS-9384 (docs/121 §121.7) — should the play button + prompt-command surface be
// hidden because the codex app-server drive is unavailable? Pure so the decision is
// unit-testable; `channelUI.tsx::initChannel` applies it (hiding the play section
// also hides prompt commands via `commandSidebar.tsx::isCommandVisible`; shell
// command buttons are unaffected).
//
// Only `ai_tool = codex` projects are gated: the toggle + handshake state are
// meaningless for every other drive. Absent status fields (older server during an
// upgrade window) fail OPEN — the surface stays visible.

export interface CodexDriveStatus {
  codexAppServerEnabled?: boolean;
  codexAppServerFailed?: boolean;
}

/** True ⇒ hide the drive surface (codex project + toggle off or handshake failed). */
export function shouldHideCodexDriveSurface(status: CodexDriveStatus, aiTool: string | undefined): boolean {
  if ((aiTool ?? '').trim().toLowerCase() !== 'codex') return false;
  return status.codexAppServerEnabled === false || status.codexAppServerFailed === true;
}
