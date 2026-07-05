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
- No markdown-sync change — `blocked_reason` is not written to `worklist.md` /
  `open-tickets.md`.

## 116.5 Automatic re-evaluation (future)

The maintainer's intent is that an AI can **re-evaluate** a blocked-reason string against
current conditions (are the referenced tickets done? has the circumstance changed?) and
update or clear it. Today that happens opportunistically when an agent processes the
worklist and chooses to call `hotsheet_update_ticket`. A scheduled/automatic sweep that
parses the `HS-NNNN` refs and clears reasons whose blockers are complete is a natural
follow-up (not built).
