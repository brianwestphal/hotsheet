/**
 * §78 Announcer (HS-8747) — the "Announcer" settings section (under Settings →
 * Experimental). Per-project opt-in toggle + an **Anthropic key selector** +
 * a privacy/cost disclosure and a live status line.
 *
 * HS-8751: the key is no longer entered here. The user manages named keys in
 * the global "API Keys" tab; this section just picks which Anthropic key this
 * project uses (or "Default — first Anthropic key" when none is chosen). The
 * dropdown repopulates when keys change elsewhere (the `hotsheet:keys-changed`
 * event) so adding a key in the Keys tab shows up here immediately.
 */
import { getAnnouncerStatus, type KeyType, listKeys, type SecretKeyMeta, selectAnnouncerKey, setAnnouncerEnabled } from '../api/index.js';
import { byId, byIdOrNull, toElement } from './dom.js';
import { showToast } from './toast.js';

const ANTHROPIC: KeyType = 'anthropic_api_key';

/** Repopulate the key <select> from the registry, preserving the project's
 *  current selection. Returns whether any Anthropic key exists. */
async function populateKeySelect(select: HTMLSelectElement, selectedId: string | null): Promise<boolean> {
  let keys: SecretKeyMeta[];
  try {
    keys = (await listKeys()).filter(k => k.type === ANTHROPIC);
  } catch {
    keys = [];
  }
  select.replaceChildren(
    toElement(<option value="">Default — first Anthropic key</option>),
    ...keys.map(k => toElement(<option value={k.id}>{k.name}</option>)),
  );
  // Restore selection (falls back to the default option when the id is gone).
  select.value = selectedId ?? '';
  if (select.value !== (selectedId ?? '')) select.value = '';
  return keys.length > 0;
}

async function refreshStatus(
  enabledCb: HTMLInputElement,
  select: HTMLSelectElement,
  statusEl: HTMLElement,
): Promise<void> {
  try {
    const status = await getAnnouncerStatus();
    enabledCb.checked = status.enabled;
    const hasAnthropicKey = await populateKeySelect(select, status.selectedKeyId);
    if (!hasAnthropicKey) {
      statusEl.textContent = 'No Anthropic keys yet — add one in the “API Keys” tab to enable narration.';
    } else if (status.hasKey) {
      statusEl.textContent = `Key configured · ${String(status.entryCount)} ${status.entryCount === 1 ? 'entry' : 'entries'} in the reel.`;
    } else {
      statusEl.textContent = 'Select an Anthropic key to enable narration.';
    }
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
  const keySelect = byIdOrNull<HTMLSelectElement>('settings-announcer-key-select');
  const statusEl = byIdOrNull('settings-announcer-status');
  if (enabledCb === null || keySelect === null || statusEl === null) return;

  // Refresh status whenever the settings dialog opens.
  byId('settings-btn').addEventListener('click', () => { void refreshStatus(enabledCb, keySelect, statusEl); });

  // Repopulate when keys are added/edited/removed in the Keys tab.
  document.addEventListener('hotsheet:keys-changed', () => {
    void refreshStatus(enabledCb, keySelect, statusEl);
  });

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

  keySelect.addEventListener('change', () => {
    void (async () => {
      try {
        await selectAnnouncerKey(keySelect.value === '' ? null : keySelect.value);
        await refreshStatus(enabledCb, keySelect, statusEl);
        onStatusChange?.();
      } catch {
        showToast('Could not save the key selection.', { variant: 'warning' });
      }
    })();
  });

  void refreshStatus(enabledCb, keySelect, statusEl);
}
