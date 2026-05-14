/**
 * §53 streaming-shell-output consumer extracted out of `commandLog.tsx` per
 * HS-8385. Owns the live partial-output write path: turning a
 * `hotsheet:shell-partial-output` CustomEvent into a store action plus the
 * pure helpers that decide what text to render in the per-row `<pre>` and
 * whether the scroll container is currently pinned to the bottom.
 *
 * The DOM-side reaction (writing the partial into the row's `<pre>`)
 * lives in `commandLogEntryRow.tsx`'s per-row partial effect — that
 * effect calls {@link writePartialIntoPre} + {@link shouldAutoScrollToBottom}
 * from here so the rules stay in one place.
 */

import { commandLogStore } from './commandLogStore.js';
import { maybeFireShellStreamFirstUseToast, type ShellPartialOutputEvent } from './commandSidebar.js';
import { state } from './state.js';
import { stripAnsi, tailLines } from './stripAnsi.js';

/**
 * HS-8015 follow-up #2 — number of trailing lines to render in the
 * collapsed running-shell preview pre. Matches the
 * `.command-log-detail`'s `-webkit-line-clamp: 3` rule visually so
 * collapsed rows look identical to completed-shell rows.
 */
export const RUNNING_SHELL_PREVIEW_LINES = 3;

/** Pure: write the rendered partial into a single `<pre>` based on its
 *  data-shell-partial-mode dataset attribute. Exported for unit tests
 *  so happy-dom doesn't need the full live event listener wired up. */
export function writePartialIntoPre(pre: HTMLElement, partial: string): void {
  const stripped = stripAnsi(partial);
  if (pre.dataset.shellPartialMode === 'preview') {
    pre.textContent = tailLines(stripped, RUNNING_SHELL_PREVIEW_LINES);
  } else {
    pre.textContent = stripped;
  }
}

/**
 * HS-7983 — sticky-bottom auto-scroll threshold (px). When the scroll
 * container is within this many px of the bottom, the partial-output
 * listener counts the user as "pinned" and re-pins after appending the
 * new chunk. Once the user scrolls up past the threshold we stop
 * auto-following so a chatty command doesn't fight a manual review.
 *
 * Value chosen empirically: needs to be larger than typical sub-pixel
 * rounding (1–2 px) but smaller than a single line of text (~16 px) so
 * scrolling up by a single line definitively unpins. 8 px hits the
 * middle of that range.
 */
const STICKY_BOTTOM_THRESHOLD_PX = 8;

/** Pure: decide whether to auto-scroll the partial-output container to
 *  the bottom after appending a chunk. Exported for unit tests so
 *  happy-dom doesn't need to mount the whole drawer to verify the rule.
 *  Inputs match `Element.scrollTop` / `clientHeight` / `scrollHeight`
 *  semantics — caller pulls them off whatever scroller wraps the
 *  partial-output `<pre>`. */
export function shouldAutoScrollToBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold: number = STICKY_BOTTOM_THRESHOLD_PX,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - threshold;
}

/**
 * HS-7983 — apply a single `hotsheet:shell-partial-output` event. HS-8318
 * §61 Phase 3b refactor: writes through the `commandLogStore` instead of
 * mutating module-level Maps + walking the DOM. The store fires the
 * per-entry `partial` signal which the per-row bindList effect reads;
 * the row's `<pre>` updates in place via that effect — no broadcast to
 * sibling rows. Sticky-bottom scroll lives inside the per-row effect
 * (captures pinned-state before the textContent write).
 *
 * Public export retained so the existing wire-up in `initCommandLog`
 * (`window.addEventListener(SHELL_PARTIAL_OUTPUT_EVENT, applyShellPartialEvent)`)
 * keeps a one-liner shape.
 */
export function applyShellPartialEvent(detail: ShellPartialOutputEvent): void {
  // HS-7984 — gate Commands Log live-render on the §53 Phase 4 setting.
  // Server still buffers + dispatches events; this consumer just
  // no-ops. Re-enabling mid-run picks up at the next chunk because the
  // server-side partial buffer survives the gate flip.
  if (!state.settings.shell_streaming_enabled) return;
  // HS-8015 — sole survivor of the previous dual-render path. The
  // first-use discoverability toast fires once per session when the
  // user first sees a live partial-output chunk, pointing them at the
  // Commands Log feature. Idempotent — the toast helper short-circuits
  // after the first invocation.
  maybeFireShellStreamFirstUseToast();
  // HS-8324 — the per-row bindList effect writes to the `<pre>` in
  // place when the store's per-entry partial signal fires. No more
  // legacy DOM-write fallback (HS-8318 retained one for the existing
  // happy-dom test suite; that suite has been migrated to drive
  // through bindList).
  commandLogStore.actions.setRunningOutput(detail.id, detail.partial);
}
