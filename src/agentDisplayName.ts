// HS-9313 / HS-9345 — map a project's `ai_tool` setting to the human display name shown
// in the channel busy indicator ("OpenCode working") and the Commands Log done entry
// ("OpenCode finished" vs the old hardcoded "Claude finished"). `auto`/`claude`/unset (and
// anything unrecognized) render as "Claude" — the default drive is Claude, so an unknown/
// auto tool keeps the current label rather than inventing one.
//
// HS-9490 (docs/132) — the per-tool name table moved to the plugin registry; this is now
// the thin lookup over it. The registry is pure (no `fs`), which is what keeps this
// module usable from BOTH the server (`/channel/done`) and the client
// (`src/client/agentName.ts` re-exports it) — see the client-safety note in
// `aiTools/types.ts`.
//
// Note this reads `displayName` (the SHORT form) rather than `productName`: these labels
// land in running text — "Claude working", "Gemini finished" — where the full product
// name ("Claude Code", "Gemini CLI") reads wrong.

import { getPlugin } from './aiTools/registry.js';

/** Human label for an `ai_tool` value. `auto`/unset/unknown → "Claude". */
export function agentDisplayName(aiTool: string | undefined): string {
  return getPlugin(aiTool)?.displayName ?? 'Claude';
}
