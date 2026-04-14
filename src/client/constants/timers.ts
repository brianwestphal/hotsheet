/** Debounce and delay constants used across the client. */
export const TIMERS = {
  /** Detail panel field auto-save debounce (title, details). */
  DETAIL_SAVE_MS: 300,
  /** Preference input save debounce. */
  PREF_SAVE_MS: 500,
  /** Search input filter debounce. */
  SEARCH_DEBOUNCE_MS: 200,
  /** Icon restore after clipboard copy. */
  ICON_RESTORE_MS: 1500,
  /** Banner auto-dismiss. */
  BANNER_DISMISS_MS: 3000,
  /** Toast notification display duration. */
  TOAST_MS: 3000,
  /** Combo dropdown blur delay (allows mousedown to fire before hide). */
  COMBO_BLUR_MS: 150,
} as const;
