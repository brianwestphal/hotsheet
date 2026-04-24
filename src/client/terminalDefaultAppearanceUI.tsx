/**
 * HS-6307 — Settings → Terminal "Default appearance" panel. Populates three
 * controls (theme / font / size) from the project's cached default appearance
 * and writes changes back to settings.json via /file-settings.
 *
 * The loader is call-on-open (from settingsDialog.tsx) so the select options
 * are fresh every time the dialog opens — adding a new theme or font to the
 * registries is picked up without a page reload.
 *
 * See docs/35-terminal-themes.md §35.6.
 */
import { api } from './api.js';
import {
  getProjectDefault,
  loadProjectDefaultAppearance,
  notifyDefaultAppearanceChanged,
  parseProjectDefault,
  setProjectDefault,
  type TerminalAppearance,
} from './terminalAppearance.js';
import {
  clampFontSize,
  DEFAULT_FONT_ID,
  DEFAULT_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  TERMINAL_FONTS,
} from './terminalFonts.js';
import { DEFAULT_THEME_ID, TERMINAL_THEMES } from './terminalThemes.js';

let wired = false;

/** Open-time entry point — refresh the cached project default from the
 *  server, render the controls, attach change listeners (once). */
export async function loadAndWireTerminalDefaultAppearance(): Promise<void> {
  await loadProjectDefaultAppearance();
  render();
  if (!wired) {
    attachListeners();
    wired = true;
  }
}

function render(): void {
  const themeSel = document.getElementById('settings-terminal-default-theme') as HTMLSelectElement | null;
  const fontSel = document.getElementById('settings-terminal-default-font') as HTMLSelectElement | null;
  const sizeInput = document.getElementById('settings-terminal-default-size') as HTMLInputElement | null;
  if (themeSel === null || fontSel === null || sizeInput === null) return;

  const current = getProjectDefault();

  // Populate options from the registries. Re-rendering on every open means a
  // freshly-added theme / font shows up without a page reload.
  themeSel.innerHTML = '';
  for (const theme of TERMINAL_THEMES) {
    const opt = document.createElement('option');
    opt.value = theme.id;
    opt.textContent = theme.name;
    if (theme.id === (current.theme ?? DEFAULT_THEME_ID)) opt.selected = true;
    themeSel.appendChild(opt);
  }

  fontSel.innerHTML = '';
  for (const font of TERMINAL_FONTS) {
    const opt = document.createElement('option');
    opt.value = font.id;
    opt.textContent = font.name;
    if (font.id === (current.fontFamily ?? DEFAULT_FONT_ID)) opt.selected = true;
    fontSel.appendChild(opt);
  }

  sizeInput.value = String(current.fontSize ?? DEFAULT_FONT_SIZE);
  sizeInput.min = String(MIN_FONT_SIZE);
  sizeInput.max = String(MAX_FONT_SIZE);
}

function attachListeners(): void {
  const themeSel = document.getElementById('settings-terminal-default-theme') as HTMLSelectElement | null;
  const fontSel = document.getElementById('settings-terminal-default-font') as HTMLSelectElement | null;
  const sizeInput = document.getElementById('settings-terminal-default-size') as HTMLInputElement | null;
  if (themeSel === null || fontSel === null || sizeInput === null) return;

  themeSel.addEventListener('change', () => { void persistField({ theme: themeSel.value }); });
  fontSel.addEventListener('change', () => { void persistField({ fontFamily: fontSel.value }); });
  sizeInput.addEventListener('change', () => {
    const parsed = Number.parseInt(sizeInput.value, 10);
    const clamped = clampFontSize(Number.isFinite(parsed) ? parsed : DEFAULT_FONT_SIZE);
    sizeInput.value = String(clamped);
    void persistField({ fontSize: clamped });
  });
}

/** Merge the given field into the cached + persisted project default. Writes
 *  to `/file-settings` and updates the module-scope cache so other xterm
 *  instances re-resolve via subscribeToDefaultAppearanceChanges. */
async function persistField(partial: Partial<TerminalAppearance>): Promise<void> {
  // Merge into the cached default first so every live xterm picks up the new
  // value immediately via notifyDefaultAppearanceChanged. The persistence
  // write races against that — if it fails, the in-memory value still
  // reflects the user's intent until the next /file-settings fetch.
  const next = { ...getProjectDefault(), ...partial };
  setProjectDefault(next); // fires the pub/sub event

  try {
    const fs = await api<{ terminal_default?: unknown }>('/file-settings');
    const existing = parseProjectDefault(fs.terminal_default);
    await api('/file-settings', { method: 'PATCH', body: { terminal_default: { ...existing, ...partial } } });
  } catch {
    /* ignore — cached value keeps the change visible until the next dialog open */
  }
  // Re-fire in case the server write changed anything (e.g. clamping we
  // haven't foreseen). Cheap; subscribers are idempotent.
  notifyDefaultAppearanceChanged();
}
