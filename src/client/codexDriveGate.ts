// HS-9384 (docs/121 §121.7) — should the play button + prompt-command surface be
// hidden because the codex app-server drive is unavailable? Pure so the decision is
// unit-testable; `channelUI.tsx::initChannel` applies it (hiding the play section
// also hides prompt commands via `commandSidebar.tsx::isCommandVisible`; shell
// command buttons are unaffected).
//
// Only `ai_tool = codex` projects are gated: the handshake state is meaningless for
// every other drive. An absent status field (older server during an upgrade window)
// fails OPEN — the surface stays visible.
//
// HS-9513 — the `codexAppServerEnabled` half is GONE. It was an Experimental toggle in
// name but the only in-app way to clear a handshake failure in practice, so it became an
// explicit "Retry Codex drive" action. A FAILED handshake is now the only thing that
// hides the surface, which is also the only one of the two a user did not choose.

export interface CodexDriveStatus {
  codexAppServerFailed?: boolean;
}

/** True ⇒ hide the drive surface (codex project whose app-server handshake failed). */
export function shouldHideCodexDriveSurface(status: CodexDriveStatus, aiTool: string | undefined): boolean {
  if ((aiTool ?? '').trim().toLowerCase() !== 'codex') return false;
  return status.codexAppServerFailed === true;
}
