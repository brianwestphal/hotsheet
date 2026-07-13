// HS-9313 / HS-9345 — map a project's `ai_tool` setting to the human display name shown
// in the channel busy indicator ("OpenCode working") and the Commands Log done entry
// ("OpenCode finished" vs the old hardcoded "Claude finished"). `auto`/`claude`/unset (and
// anything unrecognized) render as "Claude" — the default drive is Claude, so an unknown/
// auto tool keeps the current label rather than inventing one.
//
// Pure + dependency-free so BOTH the server (the `/channel/done` log entry) and the client
// (`src/client/agentName.ts` re-exports this) can use one source of truth.

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
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
