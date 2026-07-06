// HS-9246 — pure helpers for choosing the drawer's active tab when a project is
// opened. Extracted from `commandLog.tsx::applyPerProjectDrawerState` so the
// state-transition logic (new project / first-open-since-launch / saved-tab
// restore) is unit-testable without a DOM.

/** The `{{claudeCommand}}` sentinel that marks a terminal as the "Claude"
 *  terminal. Mirrors the literal used in `terminalsSettings.tsx` /
 *  `resolveCommand.ts` / `projects.ts` (the client has no shared export for it). */
export const CLAUDE_COMMAND_SENTINEL = '{{claudeCommand}}';

/** HS-9333 — the `ai_tool`-aware `{{aiCommand}}` alias (docs/113 §113.3). A terminal
 *  whose command is EITHER sentinel is "the AI terminal" for drawer-default purposes. */
export const AI_COMMAND_SENTINEL = '{{aiCommand}}';

/** HS-9333 — true when a terminal's command marks it as the project's AI terminal
 *  (either the legacy `{{claudeCommand}}` or the `{{aiCommand}}` alias). */
export function isAiTerminalCommand(command: string): boolean {
  return command === CLAUDE_COMMAND_SENTINEL || command === AI_COMMAND_SENTINEL;
}

/** The subset of a terminal config this module needs. */
export interface TerminalConfigLike {
  id: string;
  command: string;
}

/** HS-9246 / HS-9333 — the drawer tab id (`terminal:<id>`) of the AI terminal in a
 *  project's terminal configs, or null if the project has none. The AI terminal is the
 *  one whose command is an AI-tool sentinel — `{{claudeCommand}}` OR the `{{aiCommand}}`
 *  alias (regardless of how the user renamed the tab). */
export function claudeTabIdFromConfigs(
  configs: { configured: TerminalConfigLike[]; dynamic: TerminalConfigLike[] } | null,
): string | null {
  if (configs === null) return null;
  const claude = [...configs.configured, ...configs.dynamic].find(
    (c) => isAiTerminalCommand(c.command),
  );
  return claude !== undefined ? `terminal:${claude.id}` : null;
}

export interface DrawerActiveTabChoice {
  /** The persisted `drawer_active_tab`, or null when never set (new project). */
  savedTab: string | null;
  /** Whether the saved tab still resolves to a rendered drawer tab. */
  savedTabExists: boolean;
  /** The Claude tab id (`terminal:<id>`) if the project has one, else null. */
  claudeTabId: string | null;
  /** True the first time this project is opened since the app launched. */
  firstOpenSinceLaunch: boolean;
}

/** HS-9246 — pick the drawer's active tab on project open.
 *
 *  Defaults to the **Claude tab** (when the project has one) in two cases:
 *   1. a brand-new project (no saved `drawer_active_tab`), and
 *   2. the first open of any project since app launch.
 *
 *  Otherwise it restores the saved tab if it still resolves, falling back to the
 *  commands log. When the project has no Claude tab, behavior is unchanged. */
export function chooseDrawerActiveTab(c: DrawerActiveTabChoice): string {
  const isNewProject = c.savedTab === null;
  if (c.claudeTabId !== null && (isNewProject || c.firstOpenSinceLaunch)) {
    return c.claudeTabId;
  }
  return c.savedTab !== null && c.savedTabExists ? c.savedTab : 'commands-log';
}
