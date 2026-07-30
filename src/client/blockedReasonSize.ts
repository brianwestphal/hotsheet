// HS-9516 (docs/116) — size the blocked-reason editor to how much it is actually used.
//
// It shipped at `rows={2}`, a fixed height that made it TALLER than nothing and shorter
// than Details — which reads backwards, because a blocked reason is the rare case and
// Details is the common one. An empty field that permanently occupies two rows is asking
// for attention it usually doesn't deserve.
//
// So: one row when empty, and the same height as Details once it has content.
//
// The expanded height is READ FROM the Details textarea rather than hard-coded to 6.
// "The same height as details" is the actual requirement, and a literal here would
// silently stop matching the moment Details is resized — the kind of drift nobody
// notices because both fields still look fine on their own.

/** Rows for an empty blocked-reason field. */
const COLLAPSED_ROWS = 1;
/** Fallback when the Details textarea isn't present (minimal DOM, tests). */
const FALLBACK_EXPANDED_ROWS = 6;

/**
 * Apply the collapsed/expanded height for the current value. Safe to call on every
 * populate and on every keystroke — it only assigns when the value actually changes, so
 * it will not fight the browser over an unchanged attribute.
 */
export function syncBlockedReasonSize(
  blocked: HTMLTextAreaElement | null,
  details: HTMLTextAreaElement | null,
): void {
  if (blocked === null) return;
  // Whitespace-only counts as empty: a stray space or newline shouldn't leave the field
  // expanded when it reads as blank and marks the ticket unblocked everywhere else.
  const isEmpty = blocked.value.trim() === '';
  const expanded = details !== null && details.rows > 0 ? details.rows : FALLBACK_EXPANDED_ROWS;
  const next = isEmpty ? COLLAPSED_ROWS : expanded;
  if (blocked.rows !== next) blocked.rows = next;
}
