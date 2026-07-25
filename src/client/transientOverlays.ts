// HS-9441 — dismiss every TRANSIENT overlay on a project switch.
//
// The bug: hover- and anchor-based overlays are dismissed by an event on their
// ANCHOR (`mouseleave`, `blur`, an outside `click`). A project switch rebuilds the
// UI those anchors live in — the command sidebar, the git chip, the detail panel,
// the terminal drawer — so the anchor is removed from the DOM *while the overlay is
// up*, and the dismissing event never fires:
//
//   - Removing a hovered element does not fire `mouseleave`.
//   - Removing a focused element does not reliably fire `blur`.
//   - A keyboard switch (Cmd+1…9) produces no `click` for outside-click handlers.
//
// So the overlay is orphaned: stuck on screen, anchored to nothing, and — worse
// than merely ugly — showing the PREVIOUS project's data (the git popover's branch
// and dirty count, a command's last-run time). Reported for the custom-command
// tooltip; the same shape applies to every overlay listed below.
//
// This is the DOM sibling of the docs/125 project-scoped-state leak class: there,
// module state outlived a project switch; here, DOM does. `projectScoped` can't
// help — these overlays are singletons describing a shared DOM position, which
// docs/126 §126.5 says stays global. The fix is an explicit dismissal at the
// switch boundary, which is what this module is.
//
// **Adding an overlay?** If it is dismissed by an anchor event rather than by an
// explicit user action, add it here — either its own dismiss function (preferred:
// that also resets the owning module's state) or, when the owner keeps its handle
// in a closure with no exported dismiss, its class in `ORPHAN_SELECTORS`.

import { dismissAnchoredHint } from './anchoredHint.js';
import { hideCommandTooltip } from './commandTooltip.js';
import { closeContextMenu } from './contextMenu.js';
import { closeAllMenus } from './dropdown.js';
import { dismissGitStatusPopover } from './gitStatusPopover.js';
import { dismissAppearancePopover } from './terminalAppearancePopover.js';

/**
 * Backstop for overlays whose owner holds the element in a closure with no
 * exported dismiss (`tagAutocomplete.tsx`'s dropdown lives inside
 * `bindDetailTagInput`). Deliberately a SHORT, explicit list of non-modal
 * anchored transients — never a broad `[class*=overlay]` sweep, which would tear
 * down a real modal dialog (`confirm.tsx`, the settings dialog, the §47 permission
 * overlay) that the user must answer and that a project switch must not cancel.
 */
const ORPHAN_SELECTORS = ['.tag-autocomplete'] as const;

/**
 * Dismiss every transient overlay. Called from `projectTabs.tsx::switchProject`,
 * the single choke point every switch path goes through (tab click, keyboard
 * shortcut, closing a project).
 *
 * Each step is independent and best-effort: one throwing dismiss must not strand
 * the rest on screen, so a project switch never leaves a half-cleaned UI.
 * Idempotent — every dismiss below no-ops when nothing is showing.
 */
export function dismissTransientOverlays(): void {
  const steps: (() => void)[] = [
    hideCommandTooltip,      // HS-8847 command-button hover tooltip (the reported case)
    closeAllMenus,           // `.dropdown-menu` — the "Run on…" target picker, batch menus
    closeContextMenu,        // `.context-menu` — right-click ticket/row menus
    dismissAnchoredHint,     // one-off hints pointed at a control
    dismissAppearancePopover,// per-terminal theme/font popover (terminals are torn down)
    dismissGitStatusPopover, // per-PROJECT git status — stale data, not just stale chrome
  ];
  for (const step of steps) {
    try { step(); } catch { /* keep dismissing the rest */ }
  }
  for (const selector of ORPHAN_SELECTORS) {
    document.querySelectorAll(selector).forEach(el => { el.remove(); });
  }
}
