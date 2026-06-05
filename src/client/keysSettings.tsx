/**
 * HS-8751 — the "API Keys" settings tab. A machine-global, editable list of
 * named secrets (Anthropic API keys). Metadata (id/type/name/timestamps) lives
 * in `~/.hotsheet/config.json`; the secret value lives in the OS keychain and is
 * write-only here — the server never returns it. Projects select from this list
 * by name (see `announcerSettings.tsx`). docs/79-api-keys.md.
 *
 * HS-8759/8760/8761/8763 UI revision:
 *  - Only one key type exists (Google TTS dropped, HS-8763), so the type is a
 *    static label, never an editable select — which also satisfies "don't allow
 *    changing the key type after a key has been added" (HS-8759).
 *  - Each row has an **edit** button (opens a value dialog) and a lucide **trash**
 *    button; the old inline "Replace value…" field is gone, replaced by a
 *    "Created …/Updated …" provenance label (HS-8760).
 *  - "Add a key" is a button that opens a dialog with full-width Name + Value
 *    fields (HS-8761).
 */
import { createKey, deleteKey, type KeyType, listKeys, type SecretKeyMeta, updateKey } from '../api/index.js';
import type { SafeHtml } from '../jsx-runtime.js';
import { confirmDialog } from './confirm.js';
import { byIdOrNull, requireChild, toElement } from './dom.js';
import { timeAgo } from './timeAgo.js';
import { showToast } from './toast.js';

/** Human labels for the fixed key-type enum. */
const TYPE_LABELS: Record<KeyType, string> = {
  anthropic_api_key: 'Anthropic API Key',
};
/** The only registerable type today (HS-8763). */
const DEFAULT_KEY_TYPE: KeyType = 'anthropic_api_key';

const LUCIDE = {
  xmlns: 'http://www.w3.org/2000/svg',
  width: '15',
  height: '15',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '2',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
} as const;
const EDIT_ICON = <svg {...LUCIDE}><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>;
const TRASH_ICON = <svg {...LUCIDE}><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>;

/** Broadcast so dependent selectors (the Announcer key dropdown) can refresh. */
function notifyKeysChanged(): void {
  document.dispatchEvent(new CustomEvent('hotsheet:keys-changed'));
}

/** "Created 3m ago" / "Updated just now" — prefers the update stamp once a key
 *  has actually been edited. Falls back gracefully for pre-HS-8760 keys. */
function provenanceLabel(key: SecretKeyMeta): string {
  if (key.updated_at !== undefined && key.updated_at !== key.created_at) {
    return `Updated ${timeAgo(key.updated_at)}`;
  }
  if (key.created_at !== undefined) return `Created ${timeAgo(key.created_at)}`;
  return '';
}

interface KeyFieldSpec {
  label: string;
  type: 'text' | 'password';
  placeholder?: string;
  initial?: string;
  required: boolean;
}

/**
 * A small in-app form dialog (Tauri-safe; never `window.prompt`). Renders one
 * input per field, returns the trimmed values keyed by label on submit, or null
 * on cancel. Modeled on `confirm.tsx`.
 */
function openKeyFormDialog(opts: {
  title: string;
  confirmLabel: string;
  fields: KeyFieldSpec[];
}): Promise<string[] | null> {
  return new Promise((resolve) => {
    const fieldRows: SafeHtml[] = opts.fields.map(f => (
      <div className="settings-key-dialog-field">
        <label>{f.label}</label>
        <input
          type={f.type}
          className="settings-key-dialog-input"
          placeholder={f.placeholder ?? ''}
          value={f.initial ?? ''}
          autoComplete="off"
        />
      </div>
    ));

    const overlay = toElement(
      <div className="confirm-dialog-overlay" role="dialog" aria-modal="true" aria-label={opts.title}>
        <div className="confirm-dialog settings-key-dialog">
          <div className="confirm-dialog-header">{opts.title}</div>
          <div className="confirm-dialog-body">{fieldRows}</div>
          <div className="confirm-dialog-footer">
            <button type="button" className="btn btn-sm settings-key-dialog-cancel">Cancel</button>
            <button type="button" className="btn btn-sm settings-key-dialog-ok">{opts.confirmLabel}</button>
          </div>
        </div>
      </div>,
    );

    const inputs = [...overlay.querySelectorAll('.settings-key-dialog-input')]
      .filter((el): el is HTMLInputElement => el instanceof HTMLInputElement);

    let settled = false;
    const finish = (result: string[] | null): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(result);
    };

    const submit = (): void => {
      const values = inputs.map(inp => inp.value.trim());
      for (let i = 0; i < opts.fields.length; i++) {
        if (opts.fields[i].required && values[i] === '') {
          showToast(`${opts.fields[i].label} is required.`, { variant: 'warning' });
          inputs[i].focus();
          return;
        }
      }
      finish(values);
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      else if (e.key === 'Enter') { e.preventDefault(); submit(); }
    };

    requireChild<HTMLButtonElement>(overlay, '.settings-key-dialog-cancel').addEventListener('click', () => finish(null));
    requireChild<HTMLButtonElement>(overlay, '.settings-key-dialog-ok').addEventListener('click', submit);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });

    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    inputs[0]?.focus();
  });
}

function renderRow(key: SecretKeyMeta, onChanged: () => void): HTMLElement {
  const row = toElement(
    <div className="settings-key-row" data-key-id={key.id}>
      <div className="settings-key-row-main">
        <input type="text" className="settings-key-name" value={key.name} placeholder="Name" autoComplete="off" />
        <span className="settings-key-type-label">{TYPE_LABELS[key.type]}</span>
        <button type="button" className="icon-btn settings-key-edit" title="Edit value" aria-label="Edit key value">{EDIT_ICON}</button>
        <button type="button" className="icon-btn settings-key-delete" title="Delete key" aria-label="Delete key">{TRASH_ICON}</button>
      </div>
      <div className="settings-key-meta" aria-live="polite">{provenanceLabel(key)}</div>
    </div>
  );

  const nameInput = requireChild<HTMLInputElement>(row, '.settings-key-name');
  const editBtn = requireChild<HTMLButtonElement>(row, '.settings-key-edit');
  const deleteBtn = requireChild<HTMLButtonElement>(row, '.settings-key-delete');
  const metaEl = requireChild(row, '.settings-key-meta');

  // Name — debounced save on input.
  let nameTimer: ReturnType<typeof setTimeout> | null = null;
  nameInput.addEventListener('input', () => {
    if (nameTimer !== null) clearTimeout(nameTimer);
    nameTimer = setTimeout(() => {
      const name = nameInput.value.trim();
      if (name === '') return; // server rejects empty; keep the last good value
      void updateKey(key.id, { name }).then((updated) => {
        metaEl.textContent = provenanceLabel(updated);
        notifyKeysChanged();
      }).catch(() => {
        showToast('Could not rename the key.', { variant: 'warning' });
      });
    }, 600);
  });

  // Edit value — opens a dialog, then writes the new secret (HS-8760).
  editBtn.addEventListener('click', () => {
    void (async () => {
      const result = await openKeyFormDialog({
        title: `Edit “${key.name}”`,
        confirmLabel: 'Set value',
        fields: [{ label: 'New value', type: 'password', placeholder: 'sk-ant-…', required: true }],
      });
      if (result === null) return;
      try {
        const updated = await updateKey(key.id, { value: result[0] });
        metaEl.textContent = provenanceLabel(updated);
        showToast('Key value updated in the keychain.', { variant: 'success' });
        notifyKeysChanged();
      } catch {
        showToast('Could not update the value.', { variant: 'warning' });
      }
    })();
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

/** The "Add a key" flow — a dialog with full-width Name + Value fields (HS-8761). */
async function openAddKeyDialog(): Promise<void> {
  const result = await openKeyFormDialog({
    title: 'Add a key',
    confirmLabel: 'Add key',
    fields: [
      { label: 'Name', type: 'text', placeholder: 'e.g. Personal', required: true },
      { label: 'Value', type: 'password', placeholder: 'sk-ant-…', required: true },
    ],
  });
  if (result === null) return;
  const [name, value] = result;
  try {
    await createKey({ type: DEFAULT_KEY_TYPE, name, value });
    showToast('Key added.', { variant: 'success' });
    notifyKeysChanged();
    await refreshList();
  } catch {
    showToast('Could not add the key.', { variant: 'warning' });
  }
}

/** Bind the Keys tab: the "Add a key" button + the (lazy) list load on dialog open. */
export function bindKeysSettings(): void {
  const addBtn = byIdOrNull<HTMLButtonElement>('settings-key-add-btn');
  if (addBtn === null) return;

  addBtn.addEventListener('click', () => { void openAddKeyDialog(); });

  // Load the list whenever the settings dialog opens (the panel may be hidden).
  byIdOrNull('settings-btn')?.addEventListener('click', () => { void refreshList(); });
  void refreshList();
}
