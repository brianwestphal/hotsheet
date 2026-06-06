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
import { ANNOUNCER_MODEL_IDS, APPLE_FOUNDATION_MODEL_ID, DEFAULT_ANNOUNCER_MODEL, providerForModel } from '../announcer/models.js';
import { getAnnouncerDismissedTopics, getAnnouncerStatus, getGlobalConfig, type KeyType, listKeys, type SecretKeyMeta, selectAnnouncerKey, setAnnouncerDismissedTopics, setAnnouncerEnabled, updateGlobalConfig } from '../api/index.js';
import { getAnnouncerSpeakPermissions, setAnnouncerSpeakPermissions } from './announcerPermissionPref.js';
import { getAnnouncerSpeechRate, setAnnouncerSpeechRate } from './announcerSpeechRate.js';
import { byId, byIdOrNull, toElement } from './dom.js';
import { showToast } from './toast.js';

const ANTHROPIC: KeyType = 'anthropic_api_key';

/** Repopulate the key <select> from the registry, preserving the project's
 *  current selection. Returns whether any Anthropic key exists. */
async function populateKeySelect(select: HTMLSelectElement, selectedId: string | null): Promise<boolean> {
  let keys: SecretKeyMeta[];
  try {
    // Type-general filter; `KeyType` is a single value today (HS-8763) but may grow.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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

  // HS-8754 — global playback-speed select (kept in sync with the PIP's control).
  const rateSelect = byIdOrNull<HTMLSelectElement>('settings-announcer-rate');
  if (rateSelect !== null) {
    const syncRate = (): void => { rateSelect.value = String(getAnnouncerSpeechRate()); };
    syncRate();
    rateSelect.addEventListener('change', () => { void setAnnouncerSpeechRate(Number(rateSelect.value)); });
    document.addEventListener('hotsheet:announcer-rate-changed', syncRate);
    byId('settings-btn').addEventListener('click', syncRate);
  }

  // HS-8764 / HS-8790 — global summarization-model select, now spanning
  // providers. The on-device Apple option only appears + becomes the default
  // when this machine supports it (status.appleAvailable); the Anthropic key
  // field shows only while an Anthropic model is selected.
  const modelSelect = byIdOrNull<HTMLSelectElement>('settings-announcer-model');
  if (modelSelect !== null) {
    const keyField = byIdOrNull('settings-announcer-key-field');
    const appleOption = modelSelect.querySelector<HTMLOptionElement>(`option[value="${APPLE_FOUNDATION_MODEL_ID}"]`);
    const applyKeyFieldVisibility = (): void => {
      if (keyField !== null) keyField.style.display = providerForModel(modelSelect.value) === 'anthropic' ? '' : 'none';
    };
    const syncModel = (): void => {
      void Promise.all([getGlobalConfig(), getAnnouncerStatus()]).then(([cfg, status]) => {
        if (appleOption !== null) appleOption.hidden = !status.appleAvailable;
        // Explicit choice wins; else Apple-when-available, else cheapest. A
        // stored Apple choice on a machine that no longer supports it falls back.
        let value = cfg.announcerModel ?? (status.appleAvailable ? APPLE_FOUNDATION_MODEL_ID : DEFAULT_ANNOUNCER_MODEL);
        if (value === APPLE_FOUNDATION_MODEL_ID && !status.appleAvailable) value = DEFAULT_ANNOUNCER_MODEL;
        modelSelect.value = value;
        applyKeyFieldVisibility();
      }).catch(() => { applyKeyFieldVisibility(); });
    };
    syncModel();
    modelSelect.addEventListener('change', () => {
      const model = ANNOUNCER_MODEL_IDS.find(id => id === modelSelect.value);
      if (model === undefined) return;
      applyKeyFieldVisibility();
      void updateGlobalConfig({ announcerModel: model }).catch(() => {
        showToast('Could not save the model choice.', { variant: 'warning' });
      });
    });
    byId('settings-btn').addEventListener('click', syncModel);
  }

  // HS-8781 — "verbally announce permission checks" global toggle (default on).
  const speakPermsCb = byIdOrNull<HTMLInputElement>('settings-announcer-speak-permissions');
  if (speakPermsCb !== null) {
    const syncSpeakPerms = (): void => { speakPermsCb.checked = getAnnouncerSpeakPermissions(); };
    syncSpeakPerms();
    speakPermsCb.addEventListener('change', () => {
      void setAnnouncerSpeakPermissions(speakPermsCb.checked).catch(() => {
        speakPermsCb.checked = !speakPermsCb.checked; // revert on failure
        showToast('Could not save the setting.', { variant: 'warning' });
      });
    });
    byId('settings-btn').addEventListener('click', syncSpeakPerms);
  }

  // HS-8769 — the editable "uninteresting" topics list (loaded on open, saved on blur).
  const dismissedEl = byIdOrNull<HTMLTextAreaElement>('settings-announcer-dismissed');
  if (dismissedEl !== null) {
    const loadTopics = (): void => {
      void getAnnouncerDismissedTopics().then((topics) => { dismissedEl.value = topics.join('\n'); }).catch(() => { /* leave as-is */ });
    };
    loadTopics();
    dismissedEl.addEventListener('blur', () => {
      const topics = dismissedEl.value.split('\n');
      void setAnnouncerDismissedTopics(topics).then((saved) => { dismissedEl.value = saved.join('\n'); }).catch(() => {
        showToast('Could not save the topics.', { variant: 'warning' });
      });
    });
    byId('settings-btn').addEventListener('click', loadTopics);
  }

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
