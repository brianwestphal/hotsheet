/**
 * Slider state + persistence extracted out of `terminalDashboard.tsx`
 * per HS-8395 Phase 2b. Owns the column-count value (`dashboard.columnsPerRow`
 * in `/global-config`), the load promise cache, and the debounced
 * persistence timeout.
 *
 * The slider `<input>` element ref stays in `terminalDashboard.tsx` for
 * now — it is also read by the sizing-tick painting code
 * (`refreshSnapPointIndicators`) which doesn't move until Phase 3. The
 * slider element is passed into this module's I/O functions
 * (`loadSliderValue`, `bindSizeSliderInput`) as a parameter.
 *
 * Decoupling pattern: this module owns its own private state slot.
 * Cross-module side effects (post-load sizing reapply, post-input
 * sizing reapply) flow through callbacks supplied at the corresponding
 * entry point.
 */

import { getGlobalConfig, updateGlobalConfig } from '../api/index.js';
import type { GlobalConfig } from '../global-config.js';
import {
  DEFAULT_TILES_PER_ROW,
  MAX_TILES_PER_ROW,
  MIN_TILES_PER_ROW,
  perRowToSliderPosition,
  sliderPositionToPerRow,
} from './terminalDashboardSizing.js';

const SLIDER_PERSIST_DEBOUNCE_MS = 250;

interface SliderState {
  columnCount: number;
  sliderValueLoadPromise: Promise<void> | null;
  sliderPersistTimeout: ReturnType<typeof setTimeout> | null;
}

function freshSliderState(): SliderState {
  return {
    columnCount: DEFAULT_TILES_PER_ROW,
    sliderValueLoadPromise: null,
    sliderPersistTimeout: null,
  };
}

let sliderState: SliderState = freshSliderState();

/** **HS-8395 — TEST ONLY.** Clear any pending persistence timer + reset
 *  the module-level state. Mirrors the `_resetStateForTesting` pattern
 *  in `terminalDashboard.tsx` — runs the disposer before swapping in
 *  the fresh state so an in-flight `setTimeout` doesn't fire against
 *  the new state. */
export function _resetSliderStateForTesting(): void {
  if (sliderState.sliderPersistTimeout !== null) clearTimeout(sliderState.sliderPersistTimeout);
  sliderState = freshSliderState();
}

/** Read the current column count. Defaults to `DEFAULT_TILES_PER_ROW`
 *  until `loadSliderValue` resolves. */
export function getColumnCount(): number {
  return sliderState.columnCount;
}

/** Sync the slider `<input>` element's value to the current column
 *  count. Called from `enterDashboard` as a fail-safe in case the
 *  element only got mounted after `loadSliderValue` resolved. */
export function syncSliderElementValue(sliderEl: HTMLInputElement): void {
  sliderEl.value = String(perRowToSliderPosition(sliderState.columnCount));
}

/** HS-7948 / HS-8176 / HS-8290 — pure: parse a value from
 *  `dashboard.columnsPerRow` (integer 1..10) into the column count.
 *  Returns `null` for any malformed input. Pre-HS-8290 this also
 *  handled the legacy `dashboard_slider_value` 0..100 shape; that key
 *  was never promoted to global config (per user direction "delete old
 *  data automatically") so the legacy fallback was removed. Exported
 *  for unit testing — DOM- and fetch-free. */
export function parsePersistedColumnCount(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const parsed = typeof raw === 'number' ? raw : (typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN);
  if (Number.isFinite(parsed) && parsed >= MIN_TILES_PER_ROW && parsed <= MAX_TILES_PER_ROW) {
    return Math.round(parsed);
  }
  return null;
}

/** HS-7948 / HS-8176 / HS-8290 — load the persisted column count from
 *  `/global-config` once and cache the resulting promise. The
 *  `onColumnCountApplied` callback fires AFTER columnCount + slider
 *  element value are updated; the main file uses it to reapply sizing
 *  to active grids. No-op if the load fails (default is kept) or the
 *  value is malformed. */
export function loadSliderValue(opts: {
  sliderEl: HTMLInputElement | null;
  onColumnCountApplied: () => void;
}): Promise<void> {
  if (sliderState.sliderValueLoadPromise !== null) return sliderState.sliderValueLoadPromise;
  sliderState.sliderValueLoadPromise = (async () => {
    try {
      const cfg = await getGlobalConfig();
      const parsed = parsePersistedColumnCount(cfg.dashboard?.columnsPerRow);
      if (parsed !== null) {
        sliderState.columnCount = parsed;
        if (opts.sliderEl !== null) syncSliderElementValue(opts.sliderEl);
        opts.onColumnCountApplied();
      }
    } catch {
      // Keep the default — silent failure matches `loadLayoutMode`.
    }
  })();
  return sliderState.sliderValueLoadPromise;
}

/** Wire the slider's `input` event. The handler maps the LTR slider
 *  position to the inverse column count (per HS-8176 — left=many small,
 *  right=one big), fires `onColumnCountChanged` so the caller can
 *  reapply sizing, and debounces a persistence write. */
export function bindSizeSliderInput(opts: {
  sliderEl: HTMLInputElement;
  onColumnCountChanged: () => void;
}): void {
  opts.sliderEl.addEventListener('input', () => {
    // HS-8176 — slider value is the LTR position (1=leftmost,
    // MAX=rightmost). The user's mental model is left=many small,
    // right=one big, so the column count is the inverse.
    const parsed = Number.parseInt(opts.sliderEl.value, 10);
    const sliderPos = Number.isFinite(parsed) ? parsed : perRowToSliderPosition(DEFAULT_TILES_PER_ROW);
    sliderState.columnCount = sliderPositionToPerRow(sliderPos);
    opts.onColumnCountChanged();
    schedulePersistColumnCount();
  });
}

/** HS-7948 / HS-8176 / HS-8290 — debounced persistence of the column
 *  count to global config under `dashboard.columnsPerRow`. Private to
 *  this module; called from the input handler in `bindSizeSliderInput`. */
function schedulePersistColumnCount(): void {
  if (sliderState.sliderPersistTimeout !== null) clearTimeout(sliderState.sliderPersistTimeout);
  sliderState.sliderPersistTimeout = setTimeout(() => {
    sliderState.sliderPersistTimeout = null;
    // HS-8434 — type the PATCH body against the shared schema so a key
    // added here without a matching schema entry is a compile error.
    const body: Partial<GlobalConfig> = { dashboard: { columnsPerRow: sliderState.columnCount } };
    void updateGlobalConfig(body)
      .catch(() => { /* swallow — UI already reflects the new value */ });
  }, SLIDER_PERSIST_DEBOUNCE_MS);
}
