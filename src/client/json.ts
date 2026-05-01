/**
 * HS-8090 — small shared helpers for the recurring "parse JSON, validate
 * shape, fall back on corruption" pattern.
 *
 * Pre-fix the same try / Array.isArray / `as` cast triple was inlined in
 * `app.tsx`, `ticketRow.tsx`, `terminalsSettings.tsx`, plus minor
 * variations in `clipboardUtil.tsx::parseNotes` and
 * `noteRenderer.tsx::parseNotesJson`. Each callsite handled the corrupt-
 * JSON branch correctly (the original audit's claim that
 * `ticketRow.tsx:24` could crash the entire ticket-list render was
 * mistaken — it had a try/catch already), but the duplicated pattern
 * meant a future callsite that forgot one of the three pieces could
 * regress.
 *
 * `parseJsonArrayOr` collapses the pattern. Per-element shape validation
 * stays the caller's job — these helpers can't know what shape the
 * caller wants — but the JSON-parse + Array.isArray + fallback steps
 * are now in one place with one test.
 */

/**
 * Parse `raw` as a JSON array. Returns `fallback` when `raw` is empty,
 * malformed JSON, or doesn't deserialise to an array. The returned
 * array is typed `unknown[]` so callers MUST validate per-element shape
 * before using `.text`, `.id`, etc. (this helper does NOT validate
 * elements — that's caller-specific).
 *
 * Use case: `JSON.parse(ticket.notes) as { text: string }[]` callsites
 * where the surrounding code already iterates with optional-chaining or
 * structural narrowing — e.g. `parsed.map((n) => normalizeNote(n))`.
 */
export function parseJsonArrayOr<T>(raw: string | null | undefined, fallback: T): unknown[] | T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as unknown[];
  } catch { /* malformed JSON — fall through to fallback */ }
  return fallback;
}
