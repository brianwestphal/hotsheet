/**
 * HS-8558 — central registry of caps, horizons, and debounce intervals
 * that were previously declared inline at the use site (or as `const`s
 * at the top of one module). Consolidating here makes accidental drift
 * obvious (every constant is on this page) and gives each value a
 * documented purpose in one place.
 *
 * Naming: SCREAMING_SNAKE for every constant. Time-typed values carry
 * a `_MS` or `_S` suffix so the unit is unambiguous at the call site.
 * Byte-typed values carry a `_BYTES` suffix.
 *
 * Tests: there are no tests on this file specifically — every existing
 * test that exercises the bound (`shell.test.ts` for `PARTIAL_OUTPUT_CAP_BYTES`,
 * `markdown.test.ts` for the debounce intervals, etc.) keeps working
 * against the same numbers, just imported from here rather than
 * re-declared locally.
 */

/**
 * HS-8428 — orphan-cleanup horizon for draft attachments. Attachments
 * uploaded into a feedback dialog but never committed (user closed the
 * dialog, crashed tab, killed server mid-upload) sit as rows with
 * `draft_id != NULL` and no matching `feedback_drafts` row. The
 * once-per-startup cleanup deletes any such row whose `created_at` is
 * older than this horizon — long enough that a slow-typing user
 * working over a lunch break doesn't get their in-progress draft
 * blown away, short enough that abandoned drafts don't accumulate
 * indefinitely. Used by `src/cleanup.ts`.
 */
export const ORPHAN_DRAFT_ATTACHMENT_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * HS-7982 — head-truncation cap for the per-command shell-output buffer
 * (`partialOutputs` in `src/routes/shell.ts`). When a chatty command
 * (e.g. `yes`, `npm install` with verbose flags) exceeds this size, the
 * oldest bytes are dropped and a `[output truncated]\n` marker is
 * prepended so the most recent output is always readable. Without the
 * cap, a single runaway command could OOM the server.
 *
 * 4 MiB chosen as a balance: large enough to capture realistic build
 * logs in full, small enough that ~10 concurrent runaway commands
 * still fit in 50 MiB.
 */
export const PARTIAL_OUTPUT_CAP_BYTES = 4 * 1024 * 1024;

/**
 * Debounce interval for the worklist markdown sync (`worklist.md`).
 * Short because the worklist is what AI tools read on every
 * `/hotsheet` trigger — staleness here directly translates to "AI
 * agent operated on an outdated priority list". 500ms is short enough
 * to feel near-instant but long enough that a batch of edits don't
 * fan out into 50 file writes.
 */
export const WORKLIST_SYNC_DEBOUNCE_MS = 500;

/**
 * Debounce interval for the open-tickets markdown sync
 * (`open-tickets.md`). Longer than the worklist because this file is
 * primarily for the user's at-rest review, not the AI's live trigger
 * path — 5 seconds keeps the file fresh enough for "what's the
 * current state of the project?" without burning IO during a rapid
 * editing session.
 */
export const OPEN_TICKETS_SYNC_DEBOUNCE_MS = 5000;

/**
 * HS-8337 — upper bound on the `limit` query parameter for
 * `GET /api/tickets`. Per the same comment block, well above any
 * realistic single-page payload (the worst case is a fresh page-load
 * with the user's max-pagination size). Bad values return 400 so a
 * client typo doesn't silently degrade to "fetch everything".
 */
export const TICKETS_LIST_MAX_LIMIT = 10_000;

/**
 * HS-8990 — GENEROUS upper bounds on user-supplied request fields, so an
 * attacker can't balloon server memory / the DB with a single oversized field
 * (the §85 / §94.3 "abusive content" surface) while never tripping a real user.
 * Each is far above any legitimate value: a title is a line; "details"/"notes"
 * are documents (1 MiB ≈ a very long essay); a batch touches at most a few
 * thousand tickets. The body-size cap (`requestGuards`) bounds the WHOLE
 * payload; these bound INDIVIDUAL fields at the schema (`routes/validation.ts`),
 * returning 400 before the value reaches the DB. Picked deliberately — the
 * HS-8987 security-review skill flags any field that regrows unbounded.
 */
export const MAX_TITLE_CHARS = 2_000;
export const MAX_DETAILS_CHARS = 1_048_576; // 1 MiB
export const MAX_NOTES_CHARS = 1_048_576; // 1 MiB
export const MAX_TAGS_CHARS = 64 * 1024;
export const MAX_CATEGORY_CHARS = 200;
export const MAX_SEARCH_CHARS = 10_000;
export const MAX_LABEL_CHARS = 500;
export const MAX_BATCH_IDS = 50_000;
