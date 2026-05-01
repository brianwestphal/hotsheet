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
  /** Image download link cleanup delay. */
  IMAGE_DOWNLOAD_CLEANUP_MS: 100,

  // HS-8084 — polling / network-retry constants. Pre-fix these were
  // inlined as bare 5000 / 10000 / 30000 / 60000 numbers across at
  // least 8 files; renaming makes the cadence intent obvious at the
  // callsite and turns a future tuning pass from a 9-file
  // find-and-replace into a one-line edit here.

  /** Pause between polling retries on network failure / server restart.
   *  Used by the long-poll / bell-state / permission / git-status loops
   *  to avoid hammering the server during real outages. */
  POLL_RETRY_MS: 5000,
  /** Refresh cadence for the command-log panel while it's open
   *  (HS-7115 lineage — commandLog.tsx::startPolling). */
  COMMAND_LOG_REFRESH_MS: 5000,
  /** "Idle" / "done" channel-status indicator auto-hide window after
   *  the last channel/shell activity (channelUI.tsx). */
  CHANNEL_IDLE_INDICATOR_MS: 5000,
  /** Channel-auto verify window — after `channelAutoTrigger` fires,
   *  wait this long before deciding Claude didn't pick up the job and
   *  bumping the backoff counter. */
  CHANNEL_AUTO_VERIFY_MS: 10000,
  /** Heartbeat-stale window. If Claude's heartbeat hooks haven't fired
   *  within this window AND the busy flag is still set, the project's
   *  busy state is force-cleared (channelUI.tsx). */
  CHANNEL_HEARTBEAT_STALE_MS: 30000,
  /** Channel busy-state safety timeout. If Claude never calls `/done`
   *  this long after a `/trigger`, clear the busy flag so the play
   *  button doesn't get stuck. Same window applies to the §47
   *  permission-overlay's busy-extension fallback (every fresh permission
   *  request resets it). */
  CHANNEL_BUSY_TIMEOUT_MS: 60000,
} as const;
