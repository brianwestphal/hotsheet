/**
 * Per-instance appearance resolvers + the trivial `doFit` wrapper,
 * extracted out of `terminal.tsx` per HS-8396 Phase 7a. These are the
 * pure-ish helpers the drawer xterm mount path (Phase 5+6) reaches into
 * via the §54 checkout's appearance theming + post-resize fit pass.
 *
 * Owns:
 * - `resolveInstanceAppearance(inst)` — layers project default →
 *   config override → session override (HS-6307 / HS-8283).
 * - `resolveAppearanceThemeForInit(inst)` — `Partial<XTerm['options']>`
 *   shape for the initial `new XTerm({ theme: … })` call.
 * - `reapplyAppearance(inst)` — re-resolve + paint background + apply
 *   full appearance asynchronously (HS-7960 background prime + font
 *   load).
 * - `doFit(inst)` — FitAddon wrapper that swallows the "body not visible
 *   yet" exception.
 *
 * Moving these unwires four of `terminalDrawerMount.tsx`'s seven init
 * hooks — that module now imports them directly.
 */

import { getActiveProject } from './state.js';
import type { TerminalInstance } from './terminal.js';
import {
  applyAppearanceToTerm,
  getProjectDefault,
  getSessionOverride,
  resolveAppearance,
  resolveAppearanceBackground,
  type TerminalAppearance,
} from './terminalAppearance.js';
import { getThemeById, themeToXtermOptions } from './terminalThemes.js';

/** HS-6307 — resolve the appearance layers for a terminal. Factored out
 *  so mount / `reapplyAppearance` / the popover all read the same stack. */
export function resolveInstanceAppearance(inst: TerminalInstance): TerminalAppearance {
  const configOverride: { theme?: string; fontFamily?: string; fontSize?: number } = {};
  if (inst.config.theme !== undefined) configOverride.theme = inst.config.theme;
  if (inst.config.fontFamily !== undefined) configOverride.fontFamily = inst.config.fontFamily;
  if (inst.config.fontSize !== undefined) configOverride.fontSize = inst.config.fontSize;
  // HS-8283 — drawer terminals always belong to the active project, so
  // resolve against the active project's per-secret cached default.
  const activeSecret = getActiveProject()?.secret ?? '';
  return resolveAppearance({
    projectDefault: getProjectDefault(activeSecret),
    configOverride,
    sessionOverride: getSessionOverride(inst.id),
  });
}

/** Build just the xterm theme options for the initial XTerm constructor
 *  call — the full appearance (font family + size) is applied async
 *  after the terminal opens. */
export function resolveAppearanceThemeForInit(inst: TerminalInstance) {
  const appearance = resolveInstanceAppearance(inst);
  const theme = getThemeById(appearance.theme) ?? getThemeById('default')!;
  return themeToXtermOptions(theme);
}

/** Re-resolve + apply appearance to a live xterm. Called on mount, on
 *  the appearance popover's onApply callback, and on project-default
 *  changes. */
export async function reapplyAppearance(inst: TerminalInstance): Promise<void> {
  if (inst.term === null) return;
  const appearance = resolveInstanceAppearance(inst);
  // HS-7960 — paint the body's padded gutter with the new theme background
  // synchronously, BEFORE the async font load runs, so a slow font fetch
  // doesn't leave the gutter in the previous theme's color mid-flight.
  inst.body.style.backgroundColor = resolveAppearanceBackground(appearance);
  await applyAppearanceToTerm(inst.term, appearance);
}

/** FitAddon wrapper — `inst.fit.fit()` throws when the body element
 *  hasn't laid out yet (e.g. mount during a hidden tab transition).
 *  Catch + swallow so callers can `requestAnimationFrame(() => doFit(inst))`
 *  without worrying about the race. */
export function doFit(inst: TerminalInstance): void {
  if (!inst.fit) return;
  try { inst.fit.fit(); } catch { /* body not visible yet */ }
}
