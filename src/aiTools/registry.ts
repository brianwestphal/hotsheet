// HS-9490 (docs/132 §132.5) — the AI-tool plugin registry: the list, and the lookups
// everything else asks instead of branching on a tool id.
//
// **Adding a tool is one plugin module + one line in `PLUGINS`.** That is the whole
// promise of docs/132; if a change needs more than that, the interface is missing
// something and the fix belongs in `types.ts`, not in a new table somewhere.
//
// ORDER IS USER-VISIBLE — `PLUGINS` is the order the settings dropdown renders, so it
// is arranged the way the hand-written `<option>` list was (Claude first, then the CLI
// agents, then the Tier-B editor tools) rather than alphabetically.
//
// Client-safe: pure data + lookups, no `fs`. See the note in `types.ts` — the client
// bundle reaches this through `agentDisplayName.ts`. Filesystem detection lives in
// `detect.ts`, which is server-only.

import type { AgentTransport } from '../agentBackendParse.js';
import { antigravityPlugin } from './plugins/antigravity.js';
import { claudePlugin } from './plugins/claude.js';
import { codexPlugin } from './plugins/codex.js';
import { copilotPlugin } from './plugins/copilot.js';
import { cursorPlugin } from './plugins/cursor.js';
import { geminiPlugin } from './plugins/gemini.js';
import { goosePlugin } from './plugins/goose.js';
import { opencodePlugin } from './plugins/opencode.js';
import { windsurfPlugin } from './plugins/windsurf.js';
import type { AiToolPlugin } from './types.js';

export type { AiToolPlugin, AiToolTier, DetectionSpec } from './types.js';

const PLUGINS: readonly AiToolPlugin[] = [
  claudePlugin,
  codexPlugin,
  antigravityPlugin,
  geminiPlugin,
  opencodePlugin,
  goosePlugin,
  cursorPlugin,
  copilotPlugin,
  windsurfPlugin,
];

const BY_ID = new Map<string, AiToolPlugin>(PLUGINS.map(p => [p.id, p]));

/**
 * The `ai_tool` value meaning "detect and seed everything" — the default.
 *
 * Deliberately NOT a plugin (docs/132 §132.6): it is a resolution MODE over the
 * registry, not a tool. Registering it would give it an id, a display name and a
 * detection spec, none of which mean anything, and every consumer would then have to
 * special-case it back out.
 */
export const AI_TOOL_AUTO = 'auto';

/** Normalize a raw `ai_tool` setting value for lookup. Unset/blank → `auto`. */
export function normalizeAiToolId(aiTool: string | undefined | null): string {
  const t = (aiTool ?? '').trim().toLowerCase();
  return t === '' ? AI_TOOL_AUTO : t;
}

/** The plugin for an `ai_tool` value, or null for `auto` / unset / an unknown id. */
export function getPlugin(aiTool: string | undefined | null): AiToolPlugin | null {
  return BY_ID.get(normalizeAiToolId(aiTool)) ?? null;
}

/** Every registered plugin, in dropdown order. */
export function listPlugins(): readonly AiToolPlugin[] {
  return PLUGINS;
}

/**
 * HS-9508 — the drive transport for an `ai_tool` (docs/117). Client-safe: this is the
 * ONE definition, so the Settings picker's derived-default hint and the server's routing
 * cannot disagree. Before this the client kept its own hand-synced copy, marked
 * "⚠ MIRROR", which is precisely the drift docs/132 exists to remove.
 *
 * `claude-channel` for anything we do not drive — `auto`, unset, an unknown id, and the
 * Tier-B editor tools. A genuine default, not a Claude carve-out (§132.6).
 */
export function transportFor(aiTool: string | undefined | null): AgentTransport {
  return getPlugin(aiTool)?.transport ?? 'claude-channel';
}

/** True when `aiTool` names a registered plugin (i.e. an explicit tool, not `auto`). */
export function isKnownAiTool(aiTool: string | undefined | null): boolean {
  return getPlugin(aiTool) !== null;
}
