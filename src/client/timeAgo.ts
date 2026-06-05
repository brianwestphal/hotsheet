/**
 * Shared "N ago" relative-time formatter for client UI labels (the command-log
 * rows, the API-key "Created/Updated …" labels, etc.). Treats a timezone-less
 * timestamp as UTC, matching how the server stores `created_at`/`updated_at`.
 */
export function timeAgo(iso: string): string {
  // Parse the timestamp — ensure it's treated as UTC when no zone is present.
  let then: number;
  if (iso.endsWith('Z') || iso.includes('+') || (iso.includes('T') && iso.match(/[+-]\d{2}:\d{2}$/))) {
    then = new Date(iso).getTime();
  } else {
    // No timezone indicator — append Z to force UTC interpretation.
    then = new Date(iso + 'Z').getTime();
  }
  if (isNaN(then)) return iso; // fallback to raw string if unparseable

  const diffMs = Date.now() - then;
  if (diffMs < 0) return 'just now'; // clock skew
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${String(diffMin)}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${String(diffHr)}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${String(diffDay)}d ago`;
}
