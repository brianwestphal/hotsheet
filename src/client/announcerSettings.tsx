/**
 * §78 Announcer (HS-8747) — the "Announcer" settings section (under Settings →
 * Experimental). Per-project opt-in toggle + the Anthropic API key input
 * (stored in the OS keychain via `setAnnouncerKey`) + a privacy/cost
 * disclosure and a live status line.
 *
 * The key field is write-only: the server never returns the stored key (it
 * lives in the keychain), so the input stays blank and shows a "configured"
 * status instead. Saving a new value overwrites it.
 */
import { getAnnouncerStatus, setAnnouncerEnabled, setAnnouncerKey } from '../api/index.js';
import { byId, byIdOrNull } from './dom.js';
import { showToast } from './toast.js';

async function refreshStatus(
  enabledCb: HTMLInputElement,
  statusEl: HTMLElement,
): Promise<void> {
  try {
    const status = await getAnnouncerStatus();
    enabledCb.checked = status.enabled;
    statusEl.textContent = status.hasKey
      ? `API key configured · ${String(status.entryCount)} ${status.entryCount === 1 ? 'entry' : 'entries'} in the reel.`
      : 'No API key configured yet — add one below to enable narration.';
  } catch {
    statusEl.textContent = 'Could not load announcer status.';
  }
}

/**
 * Bind the Announcer settings controls. `onStatusChange` lets the caller
 * refresh dependent UI (the header Listen button) after a toggle/key change.
 */
export function bindAnnouncerSettings(onStatusChange?: () => void): void {
  const enabledCb = byIdOrNull<HTMLInputElement>('settings-announcer-enabled');
  const keyInput = byIdOrNull<HTMLInputElement>('settings-announcer-key');
  const saveKeyBtn = byIdOrNull<HTMLButtonElement>('settings-announcer-key-save');
  const statusEl = byIdOrNull('settings-announcer-status');
  if (enabledCb === null || keyInput === null || saveKeyBtn === null || statusEl === null) return;

  // Refresh status whenever the settings dialog opens.
  byId('settings-btn').addEventListener('click', () => { void refreshStatus(enabledCb, statusEl); });

  enabledCb.addEventListener('change', () => {
    void (async () => {
      try {
        await setAnnouncerEnabled(enabledCb.checked);
      } catch {
        enabledCb.checked = !enabledCb.checked; // revert on failure
        showToast('Could not update the announcer setting.', { variant: 'warning' });
        return;
      }
      onStatusChange?.();
    })();
  });

  saveKeyBtn.addEventListener('click', () => {
    void (async () => {
      const key = keyInput.value.trim();
      if (key === '') {
        showToast('Enter an Anthropic API key first.', { variant: 'warning' });
        return;
      }
      saveKeyBtn.disabled = true;
      try {
        await setAnnouncerKey(key);
        keyInput.value = '';
        showToast('Announcer API key saved to the keychain.', { variant: 'success' });
        await refreshStatus(enabledCb, statusEl);
        onStatusChange?.();
      } catch {
        showToast('Could not save the API key.', { variant: 'warning' });
      } finally {
        saveKeyBtn.disabled = false;
      }
    })();
  });

  void refreshStatus(enabledCb, statusEl);
}
