// HS-9517 — which AI tools a project may select.
//
// Two independent questions, deliberately kept apart:
//
//   AVAILABILITY — is this integration shipped at all? A property of the INTEGRATION,
//                  identical on every machine (`AiToolPlugin.maturity`). `unreleased`
//                  tools are untested and stay hidden unless the Settings → Experimental
//                  gate is on.
//   ENABLEMENT   — has the user opted into it for THIS project? A user's choice, stored
//                  per project, mirroring docs/18's `plugin_enabled:{id}`.
//
// HS-9515 removed five per-tool `dev_tool_*` gates that conflated the two: they were
// per-project runtime flags standing in for "we haven't finished this yet", which is not
// a per-project fact. Splitting them is what lets Codex ship publicly as BETA while
// Gemini and Goose — which have no working drive — stay out of users' hands entirely.
//
// Pure, so the server and client share one answer. No `fs`, no DB: callers pass in the
// settings record they already hold.

import { AI_TOOL_AUTO, getPlugin, listPlugins } from './registry.js';
import type { AiToolPlugin } from './types.js';

/**
 * The tool that is always enabled.
 *
 * Claude is the fallback transport (`transportFor` answers `claude-channel` for anything
 * we do not explicitly drive), so a project with nothing enabled must still work. Making
 * it un-disableable is what guarantees the picker can never be empty.
 */
export const ALWAYS_ENABLED_TOOL = 'claude';

/** Per-project settings key holding a tool's enabled state. Mirrors `plugin_enabled:{id}`. */
export function aiToolEnabledKey(toolId: string): string {
  return `ai_tool_enabled:${toolId}`;
}

/**
 * Is this integration shipped to users at all?
 *
 * `unreleased` is invisible unless `showUnreleased` — the ONE Settings → Experimental
 * gate that replaced the five per-tool ones.
 */
export function isAiToolAvailable(plugin: AiToolPlugin, showUnreleased: boolean): boolean {
  return plugin.maturity !== 'unreleased' || showUnreleased;
}

/** Every plugin a user may see listed, in registry (dropdown) order. */
export function availableAiTools(showUnreleased: boolean): readonly AiToolPlugin[] {
  return listPlugins().filter(p => isAiToolAvailable(p, showUnreleased));
}

/**
 * Has this project opted into `toolId`?
 *
 * Default OFF — that is the whole point: a tool is bundled but not enabled until the
 * user says so. Claude is the exception and cannot be turned off.
 *
 * `settings` is the project's key-value settings record. A value counts as enabled only
 * when it is exactly `true` or the string `'true'`: the settings table stores strings,
 * and a truthy-coercing check would enable a tool on the string `'false'`.
 */
export function isAiToolEnabled(toolId: string, settings: Record<string, unknown>): boolean {
  const id = toolId.trim().toLowerCase();
  if (id === ALWAYS_ENABLED_TOOL) return true;
  const raw = settings[aiToolEnabledKey(id)];
  return raw === true || raw === 'true';
}

/**
 * Should `toolId` be offered in the `ai_tool` picker?
 *
 * Enabled tools, plus **the one the project currently uses** — hiding the selected value
 * would silently switch a project that works today, which is the HS-9411 rule that
 * survived the gate removal because it was always about not breaking existing projects
 * rather than about gating.
 *
 * `auto` is always offered: it is a resolution mode, not a tool (docs/132 §132.6).
 */
export function isAiToolSelectable(
  toolId: string,
  settings: Record<string, unknown>,
  currentTool: string | undefined,
  showUnreleased: boolean,
): boolean {
  const id = toolId.trim().toLowerCase();
  if (id === AI_TOOL_AUTO) return true;
  const current = (currentTool ?? '').trim().toLowerCase();
  if (id === current) return true; // never hide what the project is already set to
  const plugin = getPlugin(id);
  if (plugin === null) return false;
  return isAiToolAvailable(plugin, showUnreleased) && isAiToolEnabled(id, settings);
}
