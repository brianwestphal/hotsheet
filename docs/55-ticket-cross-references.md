# 55. Ticket cross-references

HS-8036. Ticket-number references (`HS-1234`, `BUG-42`, etc.) inside any markdown-rendered text become clickable links that open a stacking dialog showing the referenced ticket. Clicking another reference inside an open dialog pushes a new dialog onto the stack — users can drill into chains of references and pop them off one-by-one.

## 55.1 Why

Notes and details routinely reference other tickets ("see HS-7969 for context", "blocked on BUG-42"). Pre-fix the user had to manually search by number to navigate the chain — a friction tax that scales with how interconnected the project's tickets are. HS-8036 makes references first-class navigation: hover-and-click instead of search-and-click.

The ticket also asks the dialog to surface the same content as the inline detail panel — so the user can read the referenced ticket's full context without losing their place in the parent ticket they were viewing.

## 55.2 Decisions (locked in 2026-04-30)

- **Link pattern.** `HS-NNNN` plus the project's configured `ticketPrefix` (per `settings.json`) plus any prefix that's appeared in the database's `tickets.ticket_number` column — a one-time scan covers legacy prefixes from projects that were renamed (`BUG-` then `HS-`).
- **Surfaces.** Anywhere markdown is rendered (notes, details, reader-mode body, the stacking dialog itself). Inside `<code>` / `<pre>` blocks too — the user explicitly opted into that on the assumption that simpler beats stricter.
- **Self-references.** A ticket viewing itself with `HS-1234` in its own notes does NOT linkify — clicking would just re-open the same ticket the user is already looking at. Link-detection skips matches equal to the current ticket's number.
- **Stale references.** Clicking `HS-9999` (no such ticket) shows a transient toast "Ticket HS-9999 not found" via the standard `showToast` helper. No persistent error UI.
- **Modal behaviour.** Stacking, modal-ish — each new dialog mounts on top of the previous one, offset by 30px in both axes so the underlying dialogs' edges peek out and the user can see depth. Backdrop click + Escape both dismiss the TOP dialog only (one level). The "Open in detail panel" header button dismisses the entire stack and switches the main detail panel to that ticket.
- **Editable in v1?** **No** — read-only display with an "Open in detail panel" CTA. Full editable behaviour requires refactoring `detail.tsx` (~30 `getElementById` callsites, scattered globals) into a parameterizable component. Read-only ships the navigation value (drill into chains of references) plus a one-click escape to edit. Editable-inline filed as a follow-up ticket.

## 55.3 Architecture

### 55.3.1 Server-side

Two new endpoints in `src/routes/tickets.ts`:

- **`GET /api/tickets/prefixes`** — returns `{ prefixes: string[] }` containing every distinct prefix in the project's `tickets.ticket_number` column, plus the project's `ticketPrefix` from `settings.json`, plus the `HS` default. Sorted alphabetically. Backed by `listKnownTicketPrefixes()` in `src/db/tickets.ts`, which runs `SELECT DISTINCT ticket_number FROM tickets` and extracts the prefix via `^([A-Z][A-Z0-9_]*)-\d+$`.
- **`GET /api/tickets/by-number/:number`** — returns the ticket row matching `ticket_number = $1`. 404 when not found. Same shape as `GET /tickets/:id` (ticket fields only — no attachments / sync metadata, since the read-only dialog doesn't need them).

### 55.3.2 Client-side `ticketRefs.ts`

Pure helper module with three exports:

- **`loadTicketPrefixes(): Promise<string[]>`** — fetches `/api/tickets/prefixes` once and caches. Concurrent callers share the in-flight promise. On error, falls back to `['HS']` so the linkify pass still works.
- **`buildTicketRefRegex(prefixes): RegExp`** — builds a global, case-sensitive regex matching `\b(PREFIX1|PREFIX2|...)-\d+\b`. Prefixes are sorted longest-first so e.g. `BUG-` beats a hypothetical `B-` in the alternation. Regex metacharacters in prefixes are escaped (defensive — prefix is user-configurable via Settings).
- **`linkifyTicketRefs(html, prefixes, currentTicketNumber?)`** — post-processes a rendered HTML string. Splits on tags via `/<[^>]*>/`, scans only the text-content runs (skips attribute values), wraps each match in `<a class="ticket-ref" data-ticket-number="HS-1234" href="javascript:void(0)">HS-1234</a>`. `currentTicketNumber` is the self-ref skip key.

`linkifyWithCachedPrefixes(html, currentTicketNumber?)` is the convenience wrapper for callsites that don't want to await the prefix-cache — it returns the input unchanged when the cache hasn't populated, so the next mutation re-renders correctly once `loadTicketPrefixes()` resolves.

### 55.3.3 Wired callsites

Linkify pass runs after every `marked.parse()` in:
- `src/client/noteRenderer.tsx::renderNotes` — the per-note body renderer.
- `src/client/detail.tsx::renderDetailsMarkdown` — the rendered-markdown view of the Details textarea (HS-8020).
- `src/client/readerOverlay.tsx::openReaderOverlay` — the §49 reader-mode overlay (note + details modes).
- `src/client/ticketRefDialog.tsx` — the stacking dialog itself, so cross-references inside a dialog also linkify.

The current ticket's number is passed as `currentTicketNumber` to skip self-references — sourced from `state.activeTicketId` lookup in `state.tickets`.

### 55.3.4 Stacking dialog (`src/client/ticketRefDialog.tsx`)

The dialog state lives in a module-private `stack: DialogEntry[]`. `openTicketRefDialog(ticketNumber)` is the public entry point — looks up the ticket (cache → server fetch fallback) and calls `pushDialog(ticket)`.

`pushDialog`:
- Computes `stackIndex = stack.length` and `offset = stackIndex * 30` for visual depth.
- Renders a `.ticket-ref-dialog-overlay` containing `.ticket-ref-dialog-backdrop` + `.ticket-ref-dialog`. The dialog uses `transform: translate(Npx, Npx)` for the offset.
- z-index: overlay + backdrop share `2600 + stackIndex*2`; dialog itself sits at `2601 + stackIndex*2`. Each push bumps both up by 2 so the next backdrop sits above the previous dialog.
- Body: header (number, title, "Open in detail" button, close button), meta chips (status / priority / category), Details section (rendered markdown with linkify), Notes section (each note's body rendered with linkify, prefixed by its timestamp).
- Mounts on `document.body` and registers `document.addEventListener('keydown', onKeydown, true)` once when the stack count hits 1.

`popTopDialog`:
- Pops the top entry, removes its overlay from the DOM.
- Removes the `keydown` listener when the stack count hits 0.

Three dismissal paths:
- Backdrop click → `popTopDialog()` (top only).
- Escape (capture-phase) → `popTopDialog()` (top only).
- "Open in detail panel" header button → `closeAllDialogs()` + `openDetail(ticket.id)` switches the main panel.

### 55.3.5 Global click handler

`bindTicketRefGlobalClickHandler()` attaches a single document-level click listener that intercepts `.ticket-ref` anchor clicks via `target.closest('.ticket-ref')`. Reads `dataset.ticketNumber` and dispatches to `openTicketRefDialog`. Wired once at app init in `app.tsx::init`.

The global handler approach (vs per-render delegation) has two benefits: (a) any rendering surface that emits `<a class="ticket-ref">` gets click handling for free, including future surfaces that haven't been written yet; (b) re-renders don't accumulate listeners.

## 55.4 SCSS

`.ticket-ref` is a thin-underlined accent-colour token with a 2-px-padding chip-ish hover state. `.ticket-ref-dialog-*` mirrors the structure of the `.reader-mode-*` overlay (HS-7957 / §49) with its own z-index range starting at 2600.

## 55.5 Tests

13 unit tests in `src/client/ticketRefs.test.ts`:
- `buildTicketRefRegex`: never-matches-empty-prefixes / single-prefix / multi-prefix-alternation / word-boundary-respect / longest-prefix-wins / regex-metacharacter-escape (6 tests).
- `linkifyTicketRefs`: single-match-canonical-anchor / multiple-matches-same-text-node / no-wrap-in-attribute-values / skip-self-reference / link-siblings-with-self-ref / empty-prefixes-pass-through / link-inside-code-blocks (7 tests).

Stacking dialog DOM tests deferred — happy-dom can render the dialog but the visual stack offset + z-index assertions don't add unit-test value beyond what manual spot-check gives. `e2e/ticket-cross-references.spec.ts` (Playwright) is the right home for end-to-end click → dialog → drill-deep → escape coverage; not implemented in v1.

## 55.6 Out of scope

- **Editable inline.** The dialog is read-only in v1. Filed as a follow-up — needs `detail.tsx` refactor.
- **Title linkification.** Ticket-list row titles aren't linkified (would conflict with row-click → open-detail). Detail-panel header title is plain text — could be linkified in a follow-up.
- **Markdown sync to `.hotsheet/worklist.md` / `open-tickets.md`.** Those AI-tool-facing files emit raw markdown; auto-links don't render there. No change needed; flagged for the AI tooling that already understands ticket numbers semantically.
- **Cross-project references.** A `HS-1234` inside Project A's notes that points to a Project B ticket fails the in-cache lookup AND the server fetch (server-side query is scoped to the active project's data dir). Toast on stale. Cross-project linkification could be added later via a "search every project" fallback, but the user-experience question (open the other project? show a peek?) needs design.

## 55.7 Cross-refs

- §3 (ticket management) — the underlying ticket model the references target.
- §4 (UI) — detail panel, notes, reader-mode overlay all become source surfaces.
- §49 (reader mode) — auto-link works inside the reader overlay too.
