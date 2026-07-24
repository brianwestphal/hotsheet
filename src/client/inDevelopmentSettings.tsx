// HS-9411 (docs/124) — the Settings → Experimental → "In Development" section.
//
// Renders one checkbox per `DEV_FEATURES` entry (`src/devFeatures.ts`), so adding
// a gate is a one-file change. Every write goes to the **local** layer explicitly
// — NOT through `persistScopedSetting`, which targets whatever scope mode the
// dialog is in. A `dev_*` key must land in `settings.local.json` even if the user
// is looking at the Shared layer, which is also why `defaultScope()` routes the
// whole prefix to `local` server-side. Two independent guarantees, on purpose.

import { getLayeredFileSettings, updateFileSettingsLayer } from '../api/index.js';
import { DEV_FEATURES,type DevFeatureKey } from '../devFeatures.js';
import { applyDevFeatureGates, setDevEnabledLocal } from './devFeatures.js';
import { byIdOrNull, toElement } from './dom.js';

/** Build the checkbox rows once, then keep them value-synced on each dialog open. */
export function bindInDevelopmentSettings(): void {
  const list = byIdOrNull('settings-in-development-list');
  if (list === null) return;

  list.replaceChildren(toElement(
    <div>
      {DEV_FEATURES.map(f => (
        <div className="settings-field settings-field-checkbox">
          <label>
            <input type="checkbox" className="in-development-toggle" data-dev-key={f.key} /> {f.label}
          </label>
          <span className="settings-hint">{f.hint}</span>
        </div>
      ))}
    </div>
  ));

  list.addEventListener('change', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    const key = target.dataset.devKey;
    if (key === undefined || key === '') return;
    // Apply locally first so the gated UI reacts immediately, then persist. A
    // failed write leaves the optimistic state until the next hydration, which
    // matches how the other Experimental toggles behave.
    setDevEnabledLocal(key as DevFeatureKey, target.checked);
    void updateFileSettingsLayer('local', { [key]: target.checked });
  });

  const settingsBtn = byIdOrNull('settings-btn');
  settingsBtn?.addEventListener('click', () => { void refreshInDevelopmentSettings(); });
}

/** Re-read the persisted values into the checkboxes (dialog open / project switch). */
export async function refreshInDevelopmentSettings(): Promise<void> {
  const list = byIdOrNull('settings-in-development-list');
  if (list === null) return;
  let resolved: Record<string, unknown>;
  try {
    resolved = (await getLayeredFileSettings()).resolved;
  } catch {
    return; // network popup handled by the api layer; leave the last-known values
  }
  list.querySelectorAll<HTMLInputElement>('.in-development-toggle').forEach((cb) => {
    const key = cb.dataset.devKey;
    if (key === undefined) return;
    cb.checked = resolved[key] === true;
  });
  applyDevFeatureGates();
}
