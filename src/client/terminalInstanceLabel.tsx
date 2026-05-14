/**
 * Per-instance label + cwd-chip DOM helpers extracted out of
 * `terminal.tsx` per HS-8396 Phase 2. Bounded extract — these functions
 * all take `inst: TerminalInstance` (or `config: TerminalTabConfig`) and
 * mutate the per-instance DOM nodes the main file already owns. No
 * cross-module state, no hooks needed.
 *
 * Owns:
 * - `tabDisplayName(config)` — pure derivation of the tab name from the
 *   config (handles `{{vars}}`, claude-prefix, .exe stripping).
 * - `effectiveHeaderLabel(inst)` — prefers `runtimeTitle` over the
 *   static config name for the in-pane toolbar label.
 * - `updateTabLabel(inst)` — updates the drawer tab label + header
 *   label + the bell glyph based on `runtimeTitle` / `hasBell` / config.
 * - `updateCwdChip(inst)` — show/hide the OSC 7 cwd chip in the
 *   toolbar based on `runtimeCwd`.
 */

import { raw } from '../jsx-runtime.js';
import { toElement } from './dom.js';
import type { TerminalInstance, TerminalTabConfig } from './terminal.js';
import { formatCwdLabel, getCachedHomeDir } from './terminalOsc7.js';

// Lucide `bell` glyph — inserted next to the tab label when `inst.hasBell`
// is true. Defined here rather than imported from `terminal.tsx` to avoid
// a runtime cycle.
const BELL_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';

export function tabDisplayName(config: TerminalTabConfig): string {
  if (typeof config.name === 'string' && config.name !== '') return config.name;
  const word = config.command.trim().split(/\s+/)[0] ?? '';
  const clean = word.replace(/^{{|}}$/g, '');
  if (clean.toLowerCase().includes('claude')) return 'claude';
  // Path-style commands like /bin/zsh → "zsh"; .exe stripped on Windows.
  const base = clean.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
  return base !== '' ? base : 'terminal';
}

/** The label for the in-pane terminal toolbar. Prefers the runtime title
 *  pushed via OSC 0/2 (HS-6473) — for shells like zsh that update their
 *  title with `cwd` or the running command, this is far more useful than
 *  the static configured name. Falls back to the static drawer-tab name
 *  when no process has pushed a title. */
export function effectiveHeaderLabel(inst: TerminalInstance): string {
  if (inst.runtimeTitle !== '') return inst.runtimeTitle;
  return tabDisplayName(inst.config);
}

export function updateTabLabel(inst: TerminalInstance): void {
  // HS-6473 follow-up: the drawer tab keeps the static configured/derived
  // name — only the in-pane toolbar follows the runtime title. Shells push
  // noisy per-cwd titles that make the narrow drawer-tab label unreadable.
  const tabName = tabDisplayName(inst.config);
  const headerName = effectiveHeaderLabel(inst);
  const labelEl = inst.tabBtn.querySelector('.drawer-tab-label');
  if (labelEl) labelEl.textContent = tabName;
  inst.label.textContent = headerName;
  inst.tabBtn.classList.toggle('has-bell', inst.hasBell);

  // Insert / remove the bell glyph as a sibling of the label. Built and
  // placed via DOM (not via re-rendering the whole tab) so the close
  // button and event listeners survive (HS-6473).
  let bellEl = inst.tabBtn.querySelector<HTMLElement>('.drawer-tab-bell');
  if (inst.hasBell) {
    if (bellEl === null) {
      bellEl = toElement(
        <span className="drawer-tab-bell" title="Bell" aria-label="Terminal bell">{raw(BELL_ICON)}</span>
      );
      // Insert immediately after the label so the order is [label][bell][close?].
      labelEl?.insertAdjacentElement('afterend', bellEl);
    }
  } else if (bellEl !== null) {
    bellEl.remove();
  }
}

export function updateCwdChip(inst: TerminalInstance): void {
  const chip = inst.header.querySelector<HTMLButtonElement>('.terminal-cwd-chip');
  const label = chip?.querySelector<HTMLElement>('.terminal-cwd-label');
  if (chip === null || label === null || label === undefined) return;
  const cwd = inst.runtimeCwd;
  if (cwd === null || cwd === '') {
    chip.style.display = 'none';
    return;
  }
  chip.style.display = '';
  label.textContent = formatCwdLabel(cwd, getCachedHomeDir());
  chip.setAttribute('title', `Open folder: ${cwd}`);
}
