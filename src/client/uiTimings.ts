/**
 * HS-8191 — Centralised UI-timing constants for the client bundle.
 *
 * Pre-HS-8191 ~20 hardcoded `setTimeout` / debounce literals were scattered
 * across the client (`200`, `2000`, `6000`, `400`, `900`, `150`, …) with
 * no easy way to spot inconsistencies (two near-identical toast surfaces
 * each picking their own auto-hide). This module is the single place to
 * name and tune those.
 *
 * Naming convention: `<UI_OR_BEHAVIOR>_<UNIT>` — units are always
 * milliseconds for setTimeout values.
 */

/** Toast / alert auto-hide for transient notices (megaphone send failure,
 *  channel-not-connected alert, …). 6 s mirrors the pre-HS-8191 literal
 *  used in `feedbackDialog.tsx` + `channelUI.tsx`. */
export const TOAST_AUTOHIDE_MS = 6000;

/** Duration a button stays in its `is-busy` visual state after a
 *  user-triggered async action (megaphone send). 2 s gives the user
 *  enough feedback that the click registered without leaving the UI
 *  feeling stuck. */
export const BUTTON_BUSY_MS = 2000;

/** Delay before a hover-driven popover closes after pointer-out. The
 *  small grace window prevents flicker when the cursor briefly crosses
 *  a non-popover element on its way to a popover-internal control. */
export const POPOVER_CLOSE_DELAY_MS = 200;

/** Length of the visual "shake" animation used to signal a no-op /
 *  rejected action (e.g. copy-output with nothing to copy). Matches the
 *  CSS `@keyframes shake` duration. */
export const SHAKE_DURATION_MS = 400;

/** Hold-time for the `copied` glyph swap on the copy-output button. */
export const COPIED_GLYPH_FLASH_MS = 900;

/** Debounce delay between an input losing focus and its autocomplete
 *  dropdown closing. The window allows a click on the dropdown itself
 *  to land before `blur` tears the dropdown down. */
export const BLUR_DEBOUNCE_MS = 150;
