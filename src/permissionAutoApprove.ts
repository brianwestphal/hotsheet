/**
 * HS-9702 (docs/137) — pure helpers for the "auto-approve a pending permission
 * after <time>" feature. Kept DOM-free + dependency-free so it is shared by the
 * settings UI, the permission overlay countdown, and the channel server's
 * pending-request lifetime (`peekPending`). All time-based logic lives here so it
 * is unit-testable without a browser or a running channel server.
 *
 * Enforcement is CLIENT-driven (the overlay shows a visible countdown and fires
 * the allow on expiry — docs/137 §137.4); the channel server only uses these
 * helpers to keep a pending request alive long enough for that countdown to run
 * (so a 15/60-minute window isn't abandoned by the §HS-9299 lone-TTL backstop
 * mid-countdown).
 */

/** The auto-approve window choices offered in Settings → Permissions, in order.
 *  `ms: 0` is the OFF sentinel (the default). The five durations mirror the
 *  HS-9702 spec (1/2/5/15/60 min). */
export const AUTO_APPROVE_OPTIONS: ReadonlyArray<{ readonly ms: number; readonly label: string }> = [
  { ms: 0, label: 'Off' },
  { ms: 60_000, label: '1 minute' },
  { ms: 120_000, label: '2 minutes' },
  { ms: 300_000, label: '5 minutes' },
  { ms: 900_000, label: '15 minutes' },
  { ms: 3_600_000, label: '60 minutes' },
];

/** The set of enabled (non-zero) window values, for O(1) validation. */
const VALID_MS = new Set(AUTO_APPROVE_OPTIONS.map(o => o.ms).filter(ms => ms > 0));

/** True when `ms` is one of the offered ENABLED windows (excludes 0 / off). */
export function isEnabledAutoApproveMs(ms: number): boolean {
  return VALID_MS.has(ms);
}

/**
 * Coerce a raw settings value (`permission_auto_approve_ms`) to a valid window in
 * ms, or 0 (OFF). Anything not exactly one of the offered enabled windows — a
 * legacy/garbage value, a string, a negative, `NaN`, `undefined` — collapses to
 * OFF, so a bad setting can never silently auto-approve on an unexpected schedule
 * (fail-closed: the safe default for a security-sensitive feature is "ask").
 */
export function parseAutoApproveMs(raw: unknown): number {
  return typeof raw === 'number' && isEnabledAutoApproveMs(raw) ? raw : 0;
}

/** True when auto-approve is enabled (a valid non-zero window) for this value. */
export function isAutoApproveEnabled(raw: unknown): boolean {
  return parseAutoApproveMs(raw) > 0;
}

/**
 * Milliseconds remaining until a request created at `createdAtMs` auto-approves
 * under `windowMs`, given `now`. Never negative (clamped to 0 = "fire now"). The
 * caller decides what to do at 0.
 */
export function autoApproveRemainingMs(createdAtMs: number, windowMs: number, now: number): number {
  return Math.max(0, createdAtMs + windowMs - now);
}

/**
 * Format a remaining-ms value as a compact `M:SS` countdown (e.g. 47_000 →
 * `"0:47"`, 125_000 → `"2:05"`). Rounds UP to whole seconds so the label shows
 * `0:01` for the final tick rather than flashing `0:00` a second early; a value
 * of 0 shows `"0:00"`.
 */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.ceil(Math.max(0, remainingMs) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${seconds.toString().padStart(2, '0')}`;
}

/** Human label for an enabled window (for audit text / tooltips), e.g. "5 minutes".
 *  Falls back to `<ms>ms` for an unexpected value. */
export function autoApproveLabel(ms: number): string {
  return AUTO_APPROVE_OPTIONS.find(o => o.ms === ms)?.label ?? `${String(ms)}ms`;
}
