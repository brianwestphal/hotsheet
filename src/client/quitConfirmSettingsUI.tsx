import { api } from './api.js';
import { byIdOrNull } from './dom.js';

/**
 * Settings → Terminal "Quit confirmation" panel (HS-7596 / §37).
 *
 * Three radio modes (always / never / with-non-exempt-processes) + an
 * editable textarea for the exempt-list basenames + a "Reset to defaults"
 * link. State lives per-project in `.hotsheet/settings.json`:
 *
 * - `confirm_quit_with_running_terminals: 'always' | 'never' | 'with-non-exempt-processes'`
 *   (default `'with-non-exempt-processes'`)
 * - `quit_confirm_exempt_processes: string[]` (default DEFAULT_EXEMPT)
 *
 * Saves are debounced (400 ms after last change) and write through the
 * existing PATCH /api/file-settings endpoint. The radio + textarea are
 * source-of-truth — there's no in-memory state here other than a
 * cached default for the Reset action.
 */

/** Mirror of `DEFAULT_EXEMPT_PROCESSES` from src/terminals/processInspect.ts.
 *  Kept duplicated rather than shared via an additional cross-module import
 *  because the client bundle would otherwise pull in the server-side ps
 *  helper transitively. The default list is short and stable. */
const DEFAULT_EXEMPT = ['screen', 'tmux', 'less', 'more', 'view', 'mandoc', 'tail', 'log', 'top', 'htop'];

export async function loadAndWireQuitConfirmSettings(): Promise<void> {
  const radios = document.querySelectorAll<HTMLInputElement>('input[name="settings-quit-confirm-mode"]');
  const exemptTextarea = byIdOrNull<HTMLTextAreaElement>('settings-quit-confirm-exempt');
  const resetBtn = byIdOrNull<HTMLButtonElement>('settings-quit-confirm-reset');
  if (radios.length === 0 || exemptTextarea === null || resetBtn === null) return;

  // Load current values.
  let mode: 'always' | 'never' | 'with-non-exempt-processes' = 'with-non-exempt-processes';
  let exempt: string[] = [...DEFAULT_EXEMPT];
  try {
    const fs = await api<{
      confirm_quit_with_running_terminals?: string;
      quit_confirm_exempt_processes?: string | string[];
    }>('/file-settings');
    if (fs.confirm_quit_with_running_terminals === 'always'
        || fs.confirm_quit_with_running_terminals === 'never'
        || fs.confirm_quit_with_running_terminals === 'with-non-exempt-processes') {
      mode = fs.confirm_quit_with_running_terminals;
    }
    const rawExempt = fs.quit_confirm_exempt_processes;
    if (typeof rawExempt === 'string' && rawExempt !== '') {
      try {
        const parsed = JSON.parse(rawExempt) as unknown;
        if (Array.isArray(parsed)) {
          exempt = parsed.filter((s): s is string => typeof s === 'string' && s !== '');
        }
      } catch { /* malformed — keep defaults */ }
    } else if (Array.isArray(rawExempt)) {
      exempt = rawExempt.filter((s): s is string => typeof s === 'string' && s !== '');
    }
  } catch { /* offline or settings missing — keep defaults */ }

  // Reflect into UI.
  for (const r of radios) r.checked = r.value === mode;
  exemptTextarea.value = exempt.join('\n');

  // Wire saves with a debounce shared between radio + textarea changes.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSave = (): void => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persistSettings();
    }, 400);
  };
  const persistSettings = async (): Promise<void> => {
    const selected = Array.from(radios).find(r => r.checked)?.value ?? 'with-non-exempt-processes';
    // Parse the textarea into a string array of non-empty trimmed lines.
    const lines = exemptTextarea.value
      .split('\n')
      .map(l => l.trim())
      .filter(l => l !== '');
    try {
      await api('/file-settings', {
        method: 'PATCH',
        body: {
          confirm_quit_with_running_terminals: selected,
          // Server stores this key as JSON (it's in JSON_VALUE_KEYS in
          // file-settings.ts), so we send the array stringified — the server
          // parses it back to native JSON before write.
          quit_confirm_exempt_processes: JSON.stringify(lines),
        },
      });
    } catch (err) {
      console.error('quitConfirmSettings: save failed', err);
    }
  };

  for (const r of radios) {
    r.addEventListener('change', scheduleSave);
  }
  exemptTextarea.addEventListener('input', scheduleSave);

  resetBtn.addEventListener('click', () => {
    exemptTextarea.value = DEFAULT_EXEMPT.join('\n');
    // Reset is treated as a user-driven change so the save fires immediately.
    scheduleSave();
  });
}
