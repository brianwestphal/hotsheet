// HS-9313 (docs/113 §113.3) — map a project's `ai_tool` setting to the display
// name shown in the channel busy indicator ("Codex working" vs "Claude working").
// `auto` and `claude` (and anything unrecognized) render as "Claude" — the
// channel/play loop today drives Claude, so an unknown/auto tool keeps the
// current label rather than inventing one.

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  goose: 'Goose',
  cursor: 'Cursor',
  copilot: 'Copilot',
  windsurf: 'Windsurf',
};

/** Human label for an `ai_tool` value. `auto`/unset/unknown → "Claude". */
export function agentDisplayName(aiTool: string | undefined): string {
  if (aiTool === undefined) return 'Claude';
  return DISPLAY_NAMES[aiTool.trim().toLowerCase()] ?? 'Claude';
}
