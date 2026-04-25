import { confirmDialog } from './confirm.js';
import {
  countHiddenForProject,
  subscribeToHiddenChanges,
  unhideAllInProject,
} from './dashboardHiddenTerminals.js';
import { getActiveProject } from './state.js';

/**
 * HS-7830 — Settings → Terminal "Reset visibility" affordance. Clears the
 * persisted `hidden_terminals` for the active project so every configured
 * terminal shows up in the dashboard / drawer-grid again, without needing
 * to open the Show / Hide Terminals dialog (§25.10.6).
 *
 * Wiring lives in `settingsDialog.tsx`'s on-open handler — `loadAndWireHiddenTerminalsReset`
 * is called there alongside the other settings init helpers (terminals
 * outline list, default appearance, quit-confirm). Idempotent: safe to call
 * on every dialog open since the subscription is registered only once.
 */

let subscriptionUnsub: (() => void) | null = null;

export function loadAndWireHiddenTerminalsReset(): void {
  const button = document.getElementById('settings-hidden-terminals-reset') as HTMLButtonElement | null;
  const status = document.getElementById('settings-hidden-terminals-status');
  if (button === null || status === null) return;

  // Idempotent — overwrite the click handler each time this is called so
  // a fresh dialog open binds against the current dashboardHiddenTerminals
  // state. Previous handlers stale-close over an outdated `secret` if the
  // user switched projects between dialog opens.
  const newButton = button.cloneNode(true) as HTMLButtonElement;
  button.replaceWith(newButton);

  newButton.addEventListener('click', async () => {
    const project = getActiveProject();
    if (project === null) return;
    const count = countHiddenForProject(project.secret);
    if (count === 0) return;
    const ok = await confirmDialog({
      title: 'Reset terminal visibility?',
      message: count === 1
        ? 'Show the 1 hidden terminal in this project again? Hidden state will also be cleared from settings.json.'
        : `Show all ${count} hidden terminals in this project again? Hidden state will also be cleared from settings.json.`,
      confirmLabel: 'Reset',
    });
    if (!ok) return;
    unhideAllInProject(project.secret);
    // The persistence layer (`persistedHiddenTerminals.ts`) subscribes to
    // the change and PATCHes `hidden_terminals: []` automatically — no
    // explicit /file-settings call needed here.
  });

  refreshStatus(newButton, status);
  if (subscriptionUnsub === null) {
    subscriptionUnsub = subscribeToHiddenChanges(() => {
      // The button + status nodes might have been replaced (e.g. dialog
      // was reopened) so look them up fresh on every fire.
      const btnNow = document.getElementById('settings-hidden-terminals-reset') as HTMLButtonElement | null;
      const statusNow = document.getElementById('settings-hidden-terminals-status');
      if (btnNow !== null && statusNow !== null) refreshStatus(btnNow, statusNow);
    });
  }
}

function refreshStatus(button: HTMLButtonElement, status: HTMLElement): void {
  const project = getActiveProject();
  const count = project === null ? 0 : countHiddenForProject(project.secret);
  if (count === 0) {
    status.textContent = 'No terminals hidden for this project.';
    button.disabled = true;
    return;
  }
  status.textContent = count === 1
    ? '1 terminal is currently hidden for this project.'
    : `${count} terminals are currently hidden for this project.`;
  button.disabled = false;
}
