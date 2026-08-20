// HS-9497 (docs/132 §132.9.2), step 2 — render a tool's declared settings.
//
// Replaces three hand-written places per toggle: the `<div class="settings-field"
// style="display:none">` in `pages.tsx`, the `byIdOrNull` binding in `settingsDialog`,
// and the `revealAgyPerms` tool-id branch. A tool's settings now come from its plugin's
// `preferences`, so adding one touches `src/aiTools/plugins/<id>.ts` and the zod field.
//
// **Why this doesn't call `createPreferenceRow`.** The ticket's goal was reusing the
// docs/18 config UI, and step 1's storage seam — the part that made reuse possible — IS
// reused. The ROW renderer is not, deliberately: it draws a `plugin-pref-row` with the
// label above and repeated as the checkbox caption, which is right inside the plugin
// dialog and visibly wrong next to the settings dialog's other `settings-field` rows.
// The ticket asks for "the same control the hand-written HTML did", and matching the
// surrounding dialog is what delivers that. What mattered was killing the hand-written
// HTML and the tool-id branch, and that happens either way.

import { raw } from 'kerfjs';

import type { AiToolPreference } from '../aiTools/types.js';
import { toElement } from './dom.js';
import { formatPrefDescription } from './prefDescription.js';

/** Current value for a declared preference, honouring its per-tool default.
 *  The default is NOT assumed false — antigravity's is off, codex's is on. */
export function preferenceValue(pref: AiToolPreference, settings: Record<string, unknown>): boolean {
  const stored = settings[pref.key];
  return typeof stored === 'boolean' ? stored : pref.default;
}

/**
 * Build the rows for one tool's preferences. Returns [] when the tool declares none,
 * which is what makes the reveal logic disappear: there is no hidden field to show, the
 * container is simply empty for tools without settings.
 */
export function buildAiToolPreferenceRows(
  prefs: readonly AiToolPreference[],
  settings: Record<string, unknown>,
  onChange: (pref: AiToolPreference, value: boolean) => void,
): HTMLElement[] {
  return prefs.map((pref) => {
    const row = toElement(
      <div className="settings-field" data-pref-key={pref.key}>
        <label>
          <input type="checkbox" id={`settings-pref-${pref.key}`} />
          {` ${pref.label}`}
        </label>
        {pref.description != null && pref.description !== ''
          // Escape-first formatting (see `prefDescription.ts`) so the `code` / **bold**
          // the hand-written hints used survives the move into a declaration. `raw()` is
          // safe here for the reason given there: every tag in the output is one we
          // wrote, because the input was escaped before any markup existed.
          // eslint-disable-next-line kerfjs/no-raw-with-dynamic-arg -- HS-9497: escape-first; see prefDescription.ts.
          ? <span className="settings-hint">{raw(formatPrefDescription(pref.description))}</span>
          : null}
      </div>
    );
    const input = row.querySelector('input');
    if (input instanceof HTMLInputElement) {
      input.checked = preferenceValue(pref, settings);
      input.addEventListener('change', () => { onChange(pref, input.checked); });
    }
    return row;
  });
}
