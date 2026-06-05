/**
 * HS-8751 — the "API Keys" settings tab. A machine-global, editable list of
 * named secrets (Anthropic API keys, Google TTS keys). Metadata (id/type/name)
 * lives in `~/.hotsheet/config.json`; the secret value lives in the OS keychain
 * and is write-only here — the server never returns it, so each row shows a
 * status instead of the value and offers a "Replace value" field. Projects
 * select from this list by name (see `announcerSettings.tsx`). docs/79-api-keys.md.
 */
import { createKey, deleteKey, type KeyType, listKeys, type SecretKeyMeta, updateKey } from '../api/index.js';
import type { SafeHtml } from '../jsx-runtime.js';
import { confirmDialog } from './confirm.js';
import { byIdOrNull, toElement } from './dom.js';
import { showToast } from './toast.js';

/** Human labels for the fixed key-type enum. */
const TYPE_LABELS: Record<KeyType, string> = {
  anthropic_api_key: 'Anthropic API Key',
  google_tts_key: 'Google TTS Key',
};
const TYPE_ORDER: KeyType[] = ['anthropic_api_key', 'google_tts_key'];

/** Broadcast so dependent selectors (the Announcer key dropdown) can refresh. */
function notifyKeysChanged(): void {
  document.dispatchEvent(new CustomEvent('hotsheet:keys-changed'));
}

function typeSelect(selected: KeyType, className: string): SafeHtml {
  return (
    <select className={className}>
      {TYPE_ORDER.map(t => (
        <option value={t} selected={t === selected}>{TYPE_LABELS[t]}</option>
      ))}
    </select>
  );
}

function renderRow(key: SecretKeyMeta, onChanged: () => void): HTMLElement {
  const row = toElement(
    <div className="settings-key-row" data-key-id={key.id}>
      <div className="settings-key-row-main">
        <input type="text" className="settings-key-name" value={key.name} placeholder="Name" autoComplete="off" />
        {typeSelect(key.type, 'settings-key-type')}
        <button type="button" className="category-delete-btn settings-key-delete" title="Delete key">{'×'}</button>
      </div>
      <div className="settings-inline-row settings-key-value-row">
        <input type="password" className="settings-key-value" placeholder="Replace value… (leave blank to keep)" autoComplete="off" />
        <button type="button" className="btn btn-sm settings-key-value-save">Set value</button>
      </div>
    </div>
  );

  const nameInput = row.querySelector<HTMLInputElement>('.settings-key-name')!;
  const typeSel = row.querySelector<HTMLSelectElement>('.settings-key-type')!;
  const valueInput = row.querySelector<HTMLInputElement>('.settings-key-value')!;
  const valueSaveBtn = row.querySelector<HTMLButtonElement>('.settings-key-value-save')!;
  const deleteBtn = row.querySelector<HTMLButtonElement>('.settings-key-delete')!;

  // Name — debounced save on input.
  let nameTimer: ReturnType<typeof setTimeout> | null = null;
  nameInput.addEventListener('input', () => {
    if (nameTimer !== null) clearTimeout(nameTimer);
    nameTimer = setTimeout(() => {
      const name = nameInput.value.trim();
      if (name === '') return; // server rejects empty; keep the last good value
      void updateKey(key.id, { name }).then(notifyKeysChanged).catch(() => {
        showToast('Could not rename the key.', { variant: 'warning' });
      });
    }, 600);
  });

  // Type — save on change.
  typeSel.addEventListener('change', () => {
    void updateKey(key.id, { type: typeSel.value as KeyType }).then(notifyKeysChanged).catch(() => {
      showToast('Could not change the key type.', { variant: 'warning' });
    });
  });

  // Replace value — explicit (write-only).
  valueSaveBtn.addEventListener('click', () => {
    const value = valueInput.value.trim();
    if (value === '') { showToast('Enter a new value first.', { variant: 'warning' }); return; }
    valueSaveBtn.disabled = true;
    void updateKey(key.id, { value }).then(() => {
      valueInput.value = '';
      showToast('Key value updated in the keychain.', { variant: 'success' });
    }).catch(() => {
      showToast('Could not update the value.', { variant: 'warning' });
    }).finally(() => { valueSaveBtn.disabled = false; });
  });

  // Delete — confirm (Tauri-safe overlay), then remove + re-render.
  deleteBtn.addEventListener('click', () => {
    void (async () => {
      const ok = await confirmDialog({
        message: `Delete the key "${key.name}"? Projects using it will fall back to the first key of its type.`,
        title: 'Delete key',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteKey(key.id);
        notifyKeysChanged();
        onChanged();
      } catch {
        showToast('Could not delete the key.', { variant: 'warning' });
      }
    })();
  });

  return row;
}

/** Fetch + render the key list into the panel. */
async function refreshList(): Promise<void> {
  const list = byIdOrNull('settings-keys-list');
  if (list === null) return;
  let keys: SecretKeyMeta[];
  try {
    keys = await listKeys();
  } catch {
    list.replaceChildren(toElement(<div className="settings-hint">Could not load keys.</div>));
    return;
  }
  if (keys.length === 0) {
    list.replaceChildren(toElement(<div className="settings-hint" style="padding:8px 0">No keys yet. Add one below.</div>));
    return;
  }
  list.replaceChildren(...keys.map(k => renderRow(k, () => { void refreshList(); })));
}

/** Bind the Keys tab: the add form + the (lazy) list load on dialog open. */
export function bindKeysSettings(): void {
  const typeSel = byIdOrNull<HTMLSelectElement>('settings-key-add-type');
  const nameInput = byIdOrNull<HTMLInputElement>('settings-key-add-name');
  const valueInput = byIdOrNull<HTMLInputElement>('settings-key-add-value');
  const addBtn = byIdOrNull<HTMLButtonElement>('settings-key-add-btn');
  if (typeSel === null || nameInput === null || valueInput === null || addBtn === null) return;

  addBtn.addEventListener('click', () => {
    const type = typeSel.value as KeyType;
    const name = nameInput.value.trim();
    const value = valueInput.value.trim();
    if (name === '') { showToast('Give the key a name.', { variant: 'warning' }); return; }
    if (value === '') { showToast('Enter the key value.', { variant: 'warning' }); return; }
    addBtn.disabled = true;
    void createKey({ type, name, value }).then(() => {
      nameInput.value = '';
      valueInput.value = '';
      showToast('Key added.', { variant: 'success' });
      notifyKeysChanged();
      return refreshList();
    }).catch(() => {
      showToast('Could not add the key.', { variant: 'warning' });
    }).finally(() => { addBtn.disabled = false; });
  });

  // Load the list whenever the settings dialog opens (the panel may be hidden).
  byIdOrNull('settings-btn')?.addEventListener('click', () => { void refreshList(); });
  void refreshList();
}
