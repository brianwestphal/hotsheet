/**
 * HS-8677 — single relative-time formatter for the client. Replaces the four
 * divergent implementations that previously lived in `crossProjectStatsPage.tsx`,
 * `backups.tsx`, `dbRecoveryBanner.tsx`, and `gitStatusChip.tsx`.
 *
 * (`longTaskObserver.tsx::formatRelativeMs` is intentionally NOT consolidated —
 *  it formats *signed* millisecond diffs for freeze-log diagnostics, a different
 *  semantic from "N minutes ago" human-readable rendering.)
 *
 * Pre-consolidation each surface picked its own units ("min/h/d", "m/h/d",
 * "minute(s)/hour(s)/day(s)"), null fallback ("—", "recently", absent), and
 * sub-minute label ("just now", "moments ago"). The unified format picks:
 *
 *  - **Long pluralized units** — `5 minutes ago`, `2 hours ago`, `3 days ago`
 *    (the design language already used by `dbRecoveryBanner` + `gitStatusChip`).
 *  - **`just now`** for the sub-minute window (3 of 4 prior surfaces used this).
 *  - Optional **`now`** (for tests) and **`fallback`** (for null / NaN / empty
 *    inputs; default `'—'`).
 *  - Optional **`absoluteThresholdMs`** — when set and exceeded, returns the
 *    absolute `toLocaleDateString()` instead of "N days ago" (used by the
 *    cross-project stats page, which previously fell back to a date past 7d).
 */
export interface FormatRelativeTimeOpts {
  /** Reference instant. Defaults to `new Date()`. Exposed for deterministic tests. */
  now?: Date;
  /** String returned for `null` / `undefined` / `''` / `NaN` inputs. Default `'—'`. */
  fallback?: string;
  /** When the elapsed time exceeds this threshold, return `toLocaleDateString()`
   *  instead of a relative string. Use `7 * 86_400_000` for the cross-project
   *  page's "show the date for entries older than a week" behavior. */
  absoluteThresholdMs?: number;
}

export function formatRelativeTime(
  input: string | number | Date | null | undefined,
  opts: FormatRelativeTimeOpts = {},
): string {
  const fallback = opts.fallback ?? '—';
  if (input === null || input === undefined || input === '') return fallback;
  let t: number;
  if (typeof input === 'number') t = input;
  else if (input instanceof Date) t = input.getTime();
  else t = new Date(input).getTime();
  if (isNaN(t)) return fallback;

  const now = opts.now ?? new Date();
  const diffMs = now.getTime() - t;
  if (opts.absoluteThresholdMs !== undefined && diffMs >= opts.absoluteThresholdMs) {
    return new Date(t).toLocaleDateString();
  }
  if (diffMs < 60_000) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
