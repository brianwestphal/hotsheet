# 116. Blocked reason — free-text "what is this waiting on" field + row indicator

Status: **Shipped** (HS-9336).

## 116.1 Problem + scope

A ticket is often stalled: waiting on another ticket, waiting on feedback (already
special-cased — see §21 and the `FEEDBACK NEEDED` note prefix), or waiting on some
other specific circumstance (an external release, a decision, a manual step). Hot Sheet
already has a **structured** dependency gate — the flat `ticket_blocked_by` table (§90.6,
HS-8865) that `claim-next` uses to skip a ticket until its blockers complete — but that is
machine-oriented (ticket-id edges only) and invisible in the list. There was no place to
record, in prose, *why* a ticket is stuck and *what would unblock it*, and no visual
signal that it is blocked at all.

This doc covers the **free-text blocked-reason** field: a nullable string an AI or the
user maintains and re-evaluates, plus the row-border indicators for blocked and
feedback-needed tickets.

## 116.2 The `blocked_reason` field

- **Data model** — a nullable `blocked_reason TEXT` column on `tickets` (migration in
  `src/db/connection.ts`; added to `TicketSchema` in `src/schemas.ts` as `.nullish()`).
  Orthogonal to `ticket_blocked_by`: it never gates `claim-next`; it is purely
  descriptive. Both can be set on the same ticket.
- **Contents** — prose and/or ticket references (`HS-1234`). Example:
  *"Waiting on HS-9330 to land the ACP client; then re-test the play button."*
- **Non-empty ⇒ blocked.** A whitespace-only value counts as cleared (`isTicketBlocked`
  in `src/client/ticketRow.tsx` trims before testing).
- **Settable by:**
  - the **AI**, via the `hotsheet_update_ticket` MCP tool's `blocked_reason` param
    (and the REST `PATCH /api/tickets/:id` body — `UpdateTicketSchema`). The tool's
    description asks the agent to **re-evaluate** the reason as conditions change and to
    **clear** it (null or empty string) once unblocked.
  - the **user**, via the detail-panel **"Blocked reason"** editor (`#detail-blocked-reason`,
    a debounced auto-save through `updateTicketField`). This editor is deliberately kept
    OUT of Hot Sheet's special undo coalescing so the field's own native text undo/redo
    works (see §116.5 / HS-9335).

## 116.3 Row indicators (borders)

A ticket row carries a 3px left border matching the `up-next` treatment, colored by state:

| State | Class | Border color |
|-------|-------|--------------|
| Up Next | `.up-next` | `--star` (gold `#eab308`) — unchanged |
| **Blocked** (non-empty `blocked_reason`) | `.blocked` | `--blocked` (dark gray `#4b5563`) |
| **Feedback needed** (last note begins `FEEDBACK NEEDED`) | `.feedback-needed` | `--feedback` (purple `#8b5cf6`, matching the feedback dot) |

**Precedence** when more than one applies is enforced by CSS source order (equal
specificity, later rule wins): **feedback > blocked > up-next**. Feedback is the most
action-urgent (it waits on the human), so its purple border wins; a ticket that is both
up-next and blocked shows the blocked gray. The classes are applied both in the initial
row JSX and re-toggled in the row's reactive effect, so an external update (channel / MCP
tool / another browser tab) keeps the border live.

The feedback-needed **border** is additive to the pre-existing feedback **dot** (§21) —
the dot marks the ticket in the list; the border makes the whole row easier to spot.

## 116.4 What this is NOT

- Not a change to the `FEEDBACK NEEDED` note flow (§21) — that detection is untouched;
  §116.3 only adds a border keyed off the same `getIndicatorDotType(...) === 'feedback'`.
- Not a change to the structured `ticket_blocked_by` gate (§90.6) — `claim-next` behavior
  is unchanged. A blocked-reason string does NOT stop a worker from claiming the ticket.
  (A future enhancement could OR the two for the border; deferred.)
- **HS-9337 update:** `blocked_reason` IS now rendered in `worklist.md` (as a `- Blocked:`
  line + the optional "possibly unblocked" hint — see §116.5); it is still not written to
  `open-tickets.md`.

## 116.5 Automatic re-evaluation — worklist hint (HS-9337, SHIPPED)

The maintainer's intent is that an AI can **re-evaluate** a blocked-reason string against
current conditions (are the referenced tickets done?) and clear it. Maintainer decision
(2026-07-06, option **a**): **surface a worklist hint, suggest-only — never silently
auto-clear.**

- **`src/blockedReasonEval.ts`** (pure) — `extractTicketRefs(reason)` parses `HS-NNNN`
  refs (uppercase prefix; `utf-8` etc. deliberately don't match); `analyzeBlockedReason(reason, statusOf)`
  reports which referenced tickets are completed/verified and whether **every known ref
  is complete** (stray non-ticket tokens are ignored); `formatUnblockHint(analysis)`
  returns the passive hint or `null`. `statusOf` is injected — no IO in the analyzer.
- **Worklist markdown (`src/sync/markdown.ts`)** — `formatTicket` now renders a
  `- Blocked: <reason>` line for any Up Next ticket with a `blocked_reason`, and when
  every referenced blocker is done, appends `⚠ Possibly unblocked: HS-1234 now
  completed/verified. Re-evaluate … and clear it …`. `syncWorklist` batch-resolves all
  referenced statuses in one query (`db/tickets.ts::getTicketStatusesByNumbers`).
- **Suggest-only** — the hint asks the agent (processing the worklist) to re-read the
  reason and clear it with judgment via `hotsheet_update_ticket`. That agent/human
  decision is the "clear signal"; nothing is ever auto-cleared, and prose-only reasons
  (no parseable refs) produce no hint.

Open sub-question left to the maintainer's default: prose-only reasons are currently
left entirely manual (no hint) — a heavier "surface prose reasons for a judgment call"
mode was not built.
