# 110. Inducing AI-Authored Review Notes (Glassbox `.pr-notes/` companion)

Requirements for the Hot Sheet side of a **cross-tool** feature: getting the AI
agents that Hot Sheet drives to emit **line-anchored, AI-authored review notes**
as a normal part of doing ticket work, so a reviewer (human or the next AI
session) reads the author's reasoning at the exact line it applies to.

The notes themselves — their on-disk format, authoring CLI, anchoring, and
rendering — are **owned by Glassbox** (its `docs/20-ai-review-notes.md`, where
the feature is substantially shipped P1–P5). Glassbox is the *consumer/renderer*
and owns the *producer toolchain* (`glassbox note …`). Hot Sheet's role is the
one piece that lives outside Glassbox: **inducement** — instructing and
encouraging the coding AI to actually produce the notes. This is the obligation
the Glassbox spec explicitly delegates in its **§20.7** ("Induce production of
notes … tracked as a corresponding Hot Sheet ticket").

> **Status: Design only (HS-8838).** No code yet. The Glassbox producer surface
> it depends on **has landed** — the `glassbox note` CLI and the canonical
> inbound instruction text via **`glassbox note instructions`** (Glassbox §20.4 /
> §20.11 "Cross-cutting", shipped). The one open product decision is the **opt-in
> / gating model** (§110.4); implementation is decomposed in §110.7, gated on the
> maintainer confirming that model.

## 110.1 Why Hot Sheet is the right place

Hot Sheet already **shapes agent behavior** at exactly the moment an agent starts
coding:

- The **worklist instructions** (`.hotsheet/worklist.md` header, authored in
  `src/sync/markdown.ts`) are read by every `/hotsheet` agent run.
- The **`/hotsheet` + `/hotsheet-worker` skill bodies** (`src/skills.ts`,
  `SKILL_VERSION`) are injected into the agent's context.
- **Ticket conventions** (status lifecycle, completion notes, FEEDBACK NEEDED)
  already train the agent to follow a process.

Adding "and emit review notes for non-obvious changes" to that same channel is
the natural, low-friction way to make note production happen — the notes appear
as a byproduct of normal ticket work, not a separate ritual.

## 110.2 The coordination contract (don't fork the wording)

Glassbox ships the **single source of truth** for *when and how* to emit notes:
`glassbox note instructions` prints the canonical inbound text
(`src/review-notes/instructions.ts` in Glassbox). Per Glassbox §20.4, any
orchestrator "runs the command and injects the output into the coding AI's
context, so the wording never forks from the actual `glassbox note` CLI surface."

**Hot Sheet shall NOT author its own copy of the note-emitting instructions.**
It runs `glassbox note instructions` and injects that output. Hot Sheet owns only:

1. **Detection** — is this project a place where notes should be induced?
   (§110.4)
2. **Injection** — surface the Glassbox text into the agent's context at the
   right place (worklist header and/or skill body).
3. **Ticket-id threading** — tell the agent to attribute each note to the ticket
   it's working (§110.5).
4. A **minimal built-in fallback nudge** for when the Glassbox CLI isn't on PATH
   but the maintainer still opted in (a short "if you can, emit `.pr-notes/`
   review notes" line, no forked detail).

This keeps the detailed contract in one place (Glassbox) and the *inducement
policy* in Hot Sheet.

## 110.3 What the agent is asked to do (summary)

The injected guidance (Glassbox-authored text + Hot Sheet's ticket-id wrapper)
asks the coding agent to, while it works a ticket:

- Emit a line-anchored note for each **non-obvious** change — rationale, proof,
  assumption, alternative-considered, risk, or test-evidence — via
  `glassbox note add --file … --lines A-B --kind … --ticket HS-NNNN --body -`
  (or, for agents that can't shell out, by writing the SARIF directly per the
  Glassbox spec).
- **Not** narrate the obvious or restate the diff; one note per genuine decision.
- Run the **final consolidation pass** Glassbox describes (mechanical
  `glassbox note coalesce` + the AI-driven merge/link pass) before finishing the
  ticket.

Hot Sheet does not re-specify any of this text — it comes from
`glassbox note instructions`.

## 110.4 Opt-in / gating model — **OPEN DECISION**

Injecting the note-emitting instructions into every agent context unconditionally
would (a) waste context tokens on projects with no Glassbox / no `.pr-notes/`
consumer, and (b) ask agents to run a CLI that may not be installed. So
inducement must be **gated**. Candidate models (a recommendation is flagged, but
this is the decision the maintainer must confirm before §110.7 is scheduled):

- **(A) Auto-detect only** — induce iff a `.pr-notes/` directory exists at the
  project root (Glassbox §20.1 — the committed notes directory). Zero config;
  "the directory's presence is the opt-in." Con: a fresh project that *wants*
  notes has no `.pr-notes/` yet (chicken-and-egg).
- **(B) Explicit per-project setting only** — a `aiReviewNotes` boolean
  (default **off**), §95-classifiable Shared/Local. Explicit, predictable. Con:
  needs a manual toggle even where `.pr-notes/` already exists.
- **(C) Both (recommended)** — induce iff the setting is on **OR** a `.pr-notes/`
  directory is detected; the setting can also force it **off** even when the
  directory exists (an explicit `false` wins). Auto-on where Glassbox is already
  in use, with a manual override either way.

**Recommended: (C).** Secondary decisions that ride on it:

- **Setting sharing class (§95)** — Shared (team-wide "this repo uses review
  notes") vs Local (per-machine)? Recommendation: **Shared** by default
  (whether a repo induces notes is a team property, like `.pr-notes/` being
  committed), with the standard per-layer override.
- **Should Hot Sheet ever *create* `.pr-notes/`?** Recommendation: **no** —
  Glassbox/`glassbox note add` owns directory creation (and the LFS
  `.gitattributes` wiring); Hot Sheet only detects + induces. It may *nudge* the
  user once if the setting is on but no CLI is found.
- **Glassbox-installed detection** — reuse the existing `isExecutableOnPath`
  helper to check for the `glassbox` CLI; if the setting/dir says "induce" but
  the CLI is absent, inject the minimal fallback nudge (§110.2.4) rather than a
  `glassbox note` command the agent can't run.

## 110.5 Ticket ↔ notes linkage (Glassbox §20.7)

Glassbox records a note's originating ticket in standard SARIF
(`result.workItemUris` / `result.properties`), populated by
`glassbox note add --ticket <id>`. Hot Sheet's injected wrapper shall tell the
agent to pass the **current ticket's `HS-NNNN`** as `--ticket`, so the note ↔
ticket link is established at author time.

**Future (own follow-up):** surface a ticket's **proof artifacts** back in the
Hot Sheet UI — e.g. a ticket detail panel section listing the `.pr-notes/`
artifacts (screenshots / test output) that the ticket's work produced, closing
the loop "what changed and why" (ticket) → "and here's the proof, at these
lines" (note). This is a read-side feature and is **not** required for
inducement; it's deferred to a separate phase (§110.7 P3).

## 110.6 Non-goals

- **Hot Sheet does not render notes.** Reading/anchoring/rendering `.pr-notes/`
  is entirely Glassbox (its §20.6).
- **Hot Sheet does not own the note format or CLI.** It never writes SARIF or
  re-specifies note kinds; it injects Glassbox's instruction text verbatim.
- **No new channel MCP tool for note authoring.** Glassbox dropped the
  `glassbox_attach_review_note` MCP idea in favor of the CLI (its §20.4);
  Hot Sheet follows suit — inducement is instruction text, not a tool.

## 110.7 Phasing (follow-up tickets)

Each slice is its own ticket; all are **gated on the §110.4 opt-in decision**.

- **P1 — Inducement injection.** A per-project setting (per the §110.4 decision)
  + detection (`.pr-notes/` dir and/or setting, `glassbox` on PATH); when on,
  inject `glassbox note instructions` output (cached at sync/skill-author time)
  into the worklist header and/or the `/hotsheet` + `/hotsheet-worker` skill
  bodies, with the ticket-id wrapper (§110.5) and the minimal fallback nudge.
  `SKILL_VERSION` bump (skill body changes → re-author on boot). Tests: gating
  on/off, CLI-present vs absent (fallback), ticket-id wrapper present.
- **P2 — Settings UI.** A checkbox in Settings (Experimental / project settings)
  for the `aiReviewNotes` setting, §95 scope-aware (Shared/Local) per the
  decision; copy explaining it requires Glassbox.
- **P3 — Ticket proof-artifact surfacing (read side).** Detect `.pr-notes/`
  notes whose `--ticket` matches a Hot Sheet ticket and surface their artifacts
  in the ticket detail panel. Independent of P1/P2; lower priority.

## 110.8 Maintenance triggers

Update this document when: the opt-in/gating model is decided or changes; the
Glassbox inbound-instructions contract (`glassbox note instructions`) or CLI
surface changes in a way that affects how Hot Sheet injects it; the ticket-id
threading mechanism changes; or a phase ships (also update
`docs/ai/requirements-summary.md`). Cross-reference Glassbox `docs/20` §20.4 /
§20.7 — that doc is the source of truth for the note format and producer
toolchain; this doc only covers Hot Sheet's inducement role.
