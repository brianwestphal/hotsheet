/**
 * HS-9126 — remember the last-selected Settings tab across dialog opens AND
 * across projects. The choice is a personal, machine-level UI preference (not
 * per-project), so it lives in `localStorage` (shared across every project on
 * this origin) rather than the project DB / settings files.
 */
const KEY = 'hotsheet:lastSettingsTab';

export function getLastSettingsTab(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setLastSettingsTab(tab: string): void {
  try {
    localStorage.setItem(KEY, tab);
  } catch {
    /* private mode / storage disabled — remembering is best-effort */
  }
}

/**
 * Activate the remembered Settings tab by clicking its tab button (so the full
 * tab-switch path runs: scope-bar update + any lazy panel load). No-op when:
 *  - nothing was remembered, or the remembered tab is General (already active),
 *  - the tab button doesn't exist (e.g. Plugins when plugins are disabled), or
 *  - the tab is currently hidden (Terminal / Updates are conditionally shown).
 *
 * Call this AFTER the dialog's open handler has reset to the General tab.
 */
export function restoreLastSettingsTab(): void {
  const tab = getLastSettingsTab();
  if (tab === null || tab === '' || tab === 'general') return;
  const btn = document.querySelector<HTMLElement>(`.settings-tab[data-tab="${tab}"]`);
  if (btn === null) return;
  if (btn.style.display === 'none') return; // conditionally-hidden tab
  btn.click();
}
