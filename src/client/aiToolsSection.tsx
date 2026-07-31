// HS-9517 — the Settings → AI tools opt-in list, and the picker filter that follows it.
//
// AI tools behave like docs/18's bundled plugins: known and built in, but **not enabled
// by default**. Claude is the exception — it is the fallback transport, so it is always
// on and has no checkbox to switch off.
//
// This replaces the five per-tool `dev_tool_*` gates HS-9515 removed. Those conflated
// "we haven't finished this" (a property of the integration) with a per-project runtime
// flag; here the two are separate — `maturity` decides what is even listed, and the
// user's per-project choice decides what is selectable.

import { aiToolEnabledKey, ALWAYS_ENABLED_TOOL, availableAiTools, isAiToolEnabled, isAiToolSelectable } from '../aiTools/enablement.js';
import type { AiToolPlugin } from '../aiTools/types.js';
import { updateSettings } from '../api/index.js';
import { byIdOrNull, toElement } from './dom.js';

/** Suffix on a beta tool's picker label, so the maturity is visible where it is chosen
 *  and not only where it was enabled. */
export const BETA_OPTION_SUFFIX = ' — beta';
/** Ditto for a tool that is only visible because the Experimental gate is on. */
export const UNRELEASED_OPTION_SUFFIX = ' — unreleased';

function maturitySuffix(plugin: AiToolPlugin): string {
  if (plugin.maturity === 'beta') return BETA_OPTION_SUFFIX;
  if (plugin.maturity === 'unreleased') return UNRELEASED_OPTION_SUFFIX;
  return '';
}

/**
 * Hide the `ai_tool` options a project may not pick.
 *
 * `option.hidden` AND `disabled`: a hidden option is still assignable by value, so a
 * stale saved value could otherwise re-select something the user cannot see.
 * `data-baseLabel` preserves the pristine text across re-opens, since the suffix is
 * appended rather than stored.
 */
export function applyAiToolAvailability(
  select: HTMLSelectElement,
  settings: Record<string, unknown>,
  currentTool: string | undefined,
  showUnreleased: boolean,
): void {
  for (const option of Array.from(select.options)) {
    const base = option.dataset.baseLabel ?? option.textContent;
    option.dataset.baseLabel = base;
    const selectable = isAiToolSelectable(option.value, settings, currentTool, showUnreleased);
    option.hidden = !selectable;
    option.disabled = !selectable;
    const plugin = availableAiTools(true).find(p => p.id === option.value);
    option.textContent = selectable && plugin !== undefined ? base + maturitySuffix(plugin) : base;
  }
}

/**
 * Render the enable list into `container`.
 *
 * `onChanged` re-runs the picker filter so enabling a tool makes it selectable
 * immediately — without it the user ticks a box and the dropdown still refuses the tool
 * until the dialog is reopened, which reads as the checkbox not working.
 */
export function renderAiToolsSection(
  container: HTMLElement,
  settings: Record<string, unknown>,
  showUnreleased: boolean,
  onChanged: (toolId: string, enabled: boolean) => void,
): void {
  const rows = availableAiTools(showUnreleased).map((plugin) => {
    const always = plugin.id === ALWAYS_ENABLED_TOOL;
    const enabled = isAiToolEnabled(plugin.id, settings);
    const row = toElement(
      <div className="settings-field ai-tool-row" data-ai-tool={plugin.id}>
        <label className="settings-checkbox-label">
          <input type="checkbox" id={`ai-tool-enabled-${plugin.id}`} checked={enabled} disabled={always} />
          {` ${plugin.productName}`}
          {plugin.maturity === 'beta' ? <span className="ai-tool-badge ai-tool-badge-beta">BETA</span> : null}
          {plugin.maturity === 'unreleased' ? <span className="ai-tool-badge ai-tool-badge-unreleased">UNRELEASED</span> : null}
          {always ? <span className="ai-tool-badge">DEFAULT</span> : null}
        </label>
      </div>
    );
    const input = row.querySelector('input');
    if (input instanceof HTMLInputElement && !always) {
      input.addEventListener('change', () => {
        // Persisted as a STRING: the settings table stores strings, and `isAiToolEnabled`
        // is written to accept both so a boolean write is not silently lost.
        void updateSettings({ [aiToolEnabledKey(plugin.id)]: String(input.checked) });
        onChanged(plugin.id, input.checked);
      });
    }
    return row;
  });
  container.replaceChildren(...rows);
}

/** Bind the section for a settings-dialog open. Safe when the container is absent. */
export function syncAiToolsSection(
  settings: Record<string, unknown>,
  showUnreleased: boolean,
  onChanged: (toolId: string, enabled: boolean) => void,
): void {
  const container = byIdOrNull('ai-tools-list');
  if (container === null) return;
  renderAiToolsSection(container, settings, showUnreleased, onChanged);
}
