/**
 * HS-6307 — per-terminal appearance popover. Gear button on the terminal
 * toolbar (drawer + dashboard dedicated view) opens this popover; user picks
 * a theme / font / font-size, optionally clicks "Reset to project default".
 *
 * Persistence depends on the terminal type:
 *   - Dynamic terminals:  session-only via setSessionOverride (wiped on page
 *     reload; survives PTY restart so user tweaks aren't lost on Stop/Start).
 *   - Configured terminals: persisted to settings.json through the file-
 *     settings PATCH, same path the terminals-list UI uses.
 *
 * Only one popover is open at a time — mountAppearancePopover dismisses any
 * previously open popover before rendering.
 *
 * See docs/35-terminal-themes.md §35.5.
 */
import { api } from './api.js';
import { toElement } from './dom.js';
import {
  clearSessionOverride,
  getProjectDefault,
  getSessionOverride,
  resolveAppearance,
  setSessionOverride,
  type TerminalAppearance,
} from './terminalAppearance.js';
import {
  clampFontSize,
  DEFAULT_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  TERMINAL_FONTS,
} from './terminalFonts.js';
import { TERMINAL_THEMES } from './terminalThemes.js';

export interface AppearancePopoverOptions {
  /** Gear button the popover anchors below. */
  anchor: HTMLElement;
  /** Terminal id — used to read/write the session override + look up the
   *  configured override in settings.json. */
  terminalId: string;
  /** True for dynamic (non-persisted) terminals; false for configured ones. */
  isDynamic: boolean;
  /** Called after any apply (theme / font / size / reset) so the caller can
   *  re-run applyAppearanceToTerm against the live xterm. */
  onApply: () => void;
}

interface OpenPopover {
  element: HTMLElement;
  captureHandler: (e: MouseEvent) => void;
  keyHandler: (e: KeyboardEvent) => void;
}

let currentPopover: OpenPopover | null = null;

/**
 * Open the appearance popover anchored below the gear button. Dismisses any
 * previously open popover first — only one at a time.
 */
export function mountAppearancePopover(opts: AppearancePopoverOptions): void {
  dismissAppearancePopover();

  const popover = buildPopoverElement(opts);
  document.body.appendChild(popover);
  positionPopover(popover, opts.anchor);

  // Dismiss on outside click. Capture phase so clicking another gear button
  // still dismisses before that button's own listener fires.
  const captureHandler = (e: MouseEvent): void => {
    const target = e.target as Node | null;
    if (target === null) return;
    if (popover.contains(target)) return;
    if (opts.anchor.contains(target)) return;
    dismissAppearancePopover();
  };
  const keyHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      dismissAppearancePopover();
    }
  };
  document.addEventListener('click', captureHandler, true);
  document.addEventListener('keydown', keyHandler);

  currentPopover = { element: popover, captureHandler, keyHandler };

  // Focus the theme select so keyboard users can tab through without first
  // locating the popover with the mouse.
  const themeSelect = popover.querySelector<HTMLSelectElement>('.terminal-appearance-theme');
  themeSelect?.focus();
}

export function dismissAppearancePopover(): void {
  if (currentPopover === null) return;
  const { element, captureHandler, keyHandler } = currentPopover;
  document.removeEventListener('click', captureHandler, true);
  document.removeEventListener('keydown', keyHandler);
  element.remove();
  currentPopover = null;
}

function buildPopoverElement(opts: AppearancePopoverOptions): HTMLElement {
  const current = resolveAppearance({
    projectDefault: getProjectDefault(),
    configOverride: {}, // configured-override is fetched below if needed
    sessionOverride: getSessionOverride(opts.terminalId),
  });

  const popover = toElement(
    <div className="terminal-appearance-popover" role="dialog" aria-label="Terminal appearance">
      <div className="terminal-appearance-row">
        <label className="terminal-appearance-label">Theme</label>
        <select className="terminal-appearance-theme">
          {TERMINAL_THEMES.map(t => (
            <option value={t.id} selected={t.id === current.theme}>{t.name}</option>
          ))}
        </select>
      </div>
      <div className="terminal-appearance-row">
        <label className="terminal-appearance-label">Font</label>
        <select className="terminal-appearance-font">
          {TERMINAL_FONTS.map(f => (
            <option value={f.id} selected={f.id === current.fontFamily}>{f.name}</option>
          ))}
        </select>
      </div>
      <div className="terminal-appearance-row">
        <label className="terminal-appearance-label">Size</label>
        <div className="terminal-appearance-size-controls">
          <button className="terminal-appearance-size-dec" type="button" title="Decrease font size">{'−'}</button>
          <input
            className="terminal-appearance-size"
            type="number"
            min={String(MIN_FONT_SIZE)}
            max={String(MAX_FONT_SIZE)}
            step="1"
            value={String(current.fontSize)}
          />
          <button className="terminal-appearance-size-inc" type="button" title="Increase font size">{'+'}</button>
        </div>
      </div>
      <div className="terminal-appearance-actions">
        <button className="terminal-appearance-reset" type="button">Reset to project default</button>
      </div>
    </div>
  );

  const themeSel = popover.querySelector<HTMLSelectElement>('.terminal-appearance-theme')!;
  const fontSel = popover.querySelector<HTMLSelectElement>('.terminal-appearance-font')!;
  const sizeInput = popover.querySelector<HTMLInputElement>('.terminal-appearance-size')!;
  const sizeDec = popover.querySelector<HTMLButtonElement>('.terminal-appearance-size-dec')!;
  const sizeInc = popover.querySelector<HTMLButtonElement>('.terminal-appearance-size-inc')!;
  const resetBtn = popover.querySelector<HTMLButtonElement>('.terminal-appearance-reset')!;

  const applyField = (field: keyof TerminalAppearance, value: string | number): void => {
    if (opts.isDynamic) {
      setSessionOverride(opts.terminalId, { [field]: value } as Partial<TerminalAppearance>);
      opts.onApply();
    } else {
      void persistConfiguredOverride(opts.terminalId, { [field]: value } as Partial<TerminalAppearance>);
      opts.onApply();
    }
  };

  themeSel.addEventListener('change', () => { applyField('theme', themeSel.value); });
  fontSel.addEventListener('change', () => { applyField('fontFamily', fontSel.value); });

  const commitSize = (value: number): void => {
    const clamped = clampFontSize(value);
    sizeInput.value = String(clamped);
    applyField('fontSize', clamped);
  };
  sizeInput.addEventListener('change', () => {
    const parsed = Number.parseInt(sizeInput.value, 10);
    commitSize(Number.isFinite(parsed) ? parsed : DEFAULT_FONT_SIZE);
  });
  sizeDec.addEventListener('click', () => {
    commitSize((Number.parseInt(sizeInput.value, 10) || DEFAULT_FONT_SIZE) - 1);
  });
  sizeInc.addEventListener('click', () => {
    commitSize((Number.parseInt(sizeInput.value, 10) || DEFAULT_FONT_SIZE) + 1);
  });

  resetBtn.addEventListener('click', () => {
    if (opts.isDynamic) {
      clearSessionOverride(opts.terminalId);
    } else {
      void clearConfiguredOverride(opts.terminalId);
    }
    // Update the popover controls to reflect the post-reset state.
    const next = resolveAppearance({
      projectDefault: getProjectDefault(),
      configOverride: {},
      sessionOverride: getSessionOverride(opts.terminalId),
    });
    themeSel.value = next.theme;
    fontSel.value = next.fontFamily;
    sizeInput.value = String(next.fontSize);
    opts.onApply();
  });

  return popover;
}

function positionPopover(popover: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  popover.style.position = 'fixed';
  popover.style.top = `${rect.bottom + 4}px`;
  // Right-align the popover to the anchor so it doesn't overflow the right
  // edge when the gear button sits far right on the toolbar.
  const popoverWidth = popover.offsetWidth || 260;
  const left = Math.max(8, Math.min(window.innerWidth - popoverWidth - 8, rect.right - popoverWidth));
  popover.style.left = `${left}px`;
}

/**
 * Persist a per-terminal appearance override to settings.json. Reads the
 * current `terminals` array, patches the matching entry, writes it back.
 */
async function persistConfiguredOverride(
  terminalId: string,
  partial: Partial<TerminalAppearance>,
): Promise<void> {
  try {
    const fs = await api<{ terminals?: unknown }>('/file-settings');
    const terminals = parseTerminalsArray(fs.terminals);
    const next = terminals.map((entry) => {
      if (entry.id !== terminalId) return entry;
      const out: Record<string, unknown> = { ...entry };
      for (const [key, value] of Object.entries(partial) as Array<[string, unknown]>) {
        if (value === undefined) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete out[key];
        } else {
          out[key] = value;
        }
      }
      return out;
    });
    await api('/file-settings', { method: 'PATCH', body: { terminals: next } });
  } catch {
    // Best-effort — if the write fails, session override still applies until
    // page reload.
  }
}

/** Remove every appearance field from a configured terminal's entry so it
 *  inherits the project default again. */
async function clearConfiguredOverride(terminalId: string): Promise<void> {
  try {
    const fs = await api<{ terminals?: unknown }>('/file-settings');
    const terminals = parseTerminalsArray(fs.terminals);
    const next = terminals.map((entry) => {
      if (entry.id !== terminalId) return entry;
      const out = { ...entry } as Record<string, unknown>;
      delete out.theme;
      delete out.fontFamily;
      delete out.fontSize;
      return out;
    });
    await api('/file-settings', { method: 'PATCH', body: { terminals: next } });
  } catch { /* ignore */ }
}

/** Tolerate both native arrays and the pre-HS-6370 stringified form. */
function parseTerminalsArray(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Array<Record<string, unknown>>; }
    catch { return []; }
  }
  return [];
}
