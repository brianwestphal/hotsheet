/**
 * HS-8858 / HS-8857 — shared clipboard helpers for copy/paste of list-shaped
 * settings (auto-context entries, custom commands) between projects.
 *
 * Copy uses `navigator.clipboard.writeText` (works in the browser AND Tauri's
 * WKWebView — already the app's copy primitive). Paste tries the one-click
 * `readText` first, then falls back to an in-app textarea overlay the user pastes
 * into — because `readText` is NOT reliably available in Tauri's WKWebView, and
 * the app's rule (CLAUDE.md) is that every feature works in both the browser and
 * Tauri. The overlay is the sanctioned in-app-dialog pattern (no `window.prompt`).
 */
import { toElement } from './dom.js';
import { showToast } from './toast.js';

/** Copy a JSON-serializable settings value to the clipboard (pretty-printed) + toast. */
export async function copyJsonToClipboard(value: unknown, label: string): Promise<void> {
  const json = JSON.stringify(value, null, 2);
  try {
    await navigator.clipboard.writeText(json);
    showToast(`${label} copied to the clipboard`, { variant: 'success' });
  } catch {
    showToast(`Couldn't copy ${label} to the clipboard`, { variant: 'warning' });
  }
}

/**
 * Get the JSON text the user wants to paste: the one-click clipboard read when it
 * works, else an in-app textarea overlay (Tauri-safe fallback). Resolves the raw
 * text, or null when the user cancels / provides nothing.
 */
export async function readClipboardJsonOrPrompt(title: string): Promise<string | null> {
  try {
    const text = await navigator.clipboard.readText();
    if (typeof text === 'string' && text.trim() !== '') return text;
  } catch { /* fall through to the manual paste overlay */ }
  return promptPasteOverlay(title);
}

/** In-app textarea overlay the user pastes into (⌘/Ctrl+V) then Imports. Tauri-safe
 *  — no `readText`, no `window.prompt`. Reuses the confirm-dialog visual shell. */
function promptPasteOverlay(title: string): Promise<string | null> {
  return new Promise(resolve => {
    const overlay = toElement(
      <div className="confirm-dialog-overlay" role="dialog" aria-modal="true" aria-label={title}>
        <div className="confirm-dialog">
          <div className="confirm-dialog-header">{title}</div>
          <div className="confirm-dialog-body">
            <div className="settings-hint" style="margin-bottom:6px">Paste the copied settings JSON below (⌘/Ctrl+V), then Import.</div>
            <textarea className="settings-textarea settings-paste-textarea" rows={8} spellcheck={false} autocomplete="off"></textarea>
          </div>
          <div className="confirm-dialog-footer">
            <button type="button" className="btn btn-sm settings-paste-cancel">Cancel</button>
            <button type="button" className="btn btn-sm settings-paste-import">Import</button>
          </div>
        </div>
      </div>
    );
    const textarea = overlay.querySelector<HTMLTextAreaElement>('.settings-paste-textarea')!;
    let settled = false;
    const finish = (result: string | null): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(result);
    };
    const submit = (): void => finish(textarea.value.trim() === '' ? null : textarea.value);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      // Enter inserts newlines in the textarea; require a modifier to submit.
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    };
    overlay.querySelector('.settings-paste-cancel')!.addEventListener('click', () => finish(null));
    overlay.querySelector('.settings-paste-import')!.addEventListener('click', submit);
    overlay.addEventListener('click', e => { if (e.target === overlay) finish(null); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    textarea.focus();
  });
}

/**
 * Parse pasted JSON into an array of settings entries, or null with a toast on any
 * problem (not JSON, not an array, or the zod validation fails). `label` names the
 * setting for the message. `validate` is a predicate-narrowing guard (typically a
 * zod `safeParse` wrapper) so the caller gets a typed array back.
 */
export function parsePastedEntries<T>(raw: string, label: string, validate: (v: unknown) => T[] | null): T[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    showToast(`That isn't valid JSON — copy the ${label} again and retry`, { variant: 'warning' });
    return null;
  }
  const entries = validate(parsed);
  if (entries === null) {
    showToast(`That JSON isn't valid ${label}`, { variant: 'warning' });
    return null;
  }
  return entries;
}

/** The entries in `incoming` whose id isn't already present in `existing` (by
 *  `idOf`) — the "add only what's new" merge used by paste/import. Pure. */
export function newEntriesById<T>(existing: readonly T[], incoming: readonly T[], idOf: (t: T) => string): T[] {
  const have = new Set(existing.map(idOf));
  return incoming.filter(e => !have.has(idOf(e)));
}
