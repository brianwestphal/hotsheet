/**
 * HS-9584 — derive a terminal's display label from its configured command,
 * for the case where the terminal has no explicit `name`.
 *
 * ## Why this is one function
 *
 * The same six lines were copy-pasted into three surfaces — the drawer tab
 * (`terminalInstanceLabel.tsx`), the drawer tile grid (`drawerTerminalGrid.tsx`)
 * and the dashboard tile (`terminalDashboardTiles.tsx`). All three said
 * `claude` for an AI terminal, which is wrong for a project whose `ai_tool` is
 * codex / antigravity / opencode / gemini / goose, and fixing one copy would
 * have left two surfaces disagreeing with it. Consolidating is the part that
 * keeps the fix from regressing.
 *
 * ## Why "AI" and not the resolved tool name
 *
 * The label is derived from the **template**, not the resolved binary:
 * `{{aiCommand}}` and its legacy alias `{{claudeCommand}}` both expand through
 * the `ai_tool`-aware `pickAiCommand` (`terminals/resolveCommand.ts`), and the
 * client does not resolve them — the server does, at spawn time. So the honest
 * label for the unspawned config is the category, not a guess at which tool it
 * will turn out to be. The in-pane toolbar still follows the runtime OSC 0/2
 * title once a process pushes one, which is where the specific name shows up.
 */

/** Both templates that expand via `pickAiCommand`. `{{claudeCommand}}` is the
 *  legacy spelling kept for back-compat (HS-8009); it is NOT claude-specific. */
const AI_COMMAND_TOKENS = ['aicommand', 'claudecommand'];

export const AI_TERMINAL_LABEL = 'AI';

/**
 * Label for a nameless terminal, from its command string. Returns the basename
 * of the first word (`/bin/zsh` → `zsh`, `foo.exe` → `foo`), `AI` for either AI
 * template, or `terminal` when there is nothing to go on.
 */
export function deriveTerminalLabel(command: string): string {
  const word = command.trim().split(/\s+/)[0] ?? '';
  const clean = word.replace(/^{{|}}$/g, '');
  if (AI_COMMAND_TOKENS.includes(clean.toLowerCase())) return AI_TERMINAL_LABEL;
  const base = clean.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
  return base !== '' ? base : 'terminal';
}
