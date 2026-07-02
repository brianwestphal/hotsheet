# 111. Ticket Proof-Artifact Surfacing (Glassbox `.pr-notes/` read side)

> **Status: Design decided (HS-9223, maintainer 2026-07-02); Phase 1 (reader) shipped.**
> The read-side companion to [docs/110](110-ai-review-notes-inducement.md) (which
> *induces* agents to author `.pr-notes/` review notes). This closes the loop:
> "what changed and why" (the Hot Sheet **ticket**) → "and here's the proof, at
> these lines" (the Glassbox **note**). Follow-up to HS-8838 / docs/110 §110.7 P3.

## 111.1 Goal

When a Glassbox review note in `<repo>/.pr-notes/` links a Hot Sheet ticket (via
`glassbox note add --ticket HS-NNNN`), surface that note's proof artifacts
(screenshots, test output) in the ticket's detail panel. Hot Sheet **reads +
displays**; Glassbox owns authoring, the SARIF format, and rich rendering
(docs/110 §110.6). Hot Sheet never writes `.pr-notes/`.

## 111.2 Maintainer decisions (2026-07-02)

- **Q1 — Read mechanism → (b) DIRECT SARIF read.** Hot Sheet scans
  `<repo>/.pr-notes/notes/**/*.sarif` and parses them itself (no dependency on a
  new Glassbox CLI command). Glassbox still owns authoring; Hot Sheet only reads.
- **Q2 — Render depth → (a) light list, then click into (b) rich.** The detail
  panel shows a compact **"Review proof (N)"** section listing each matching note
  (kind + `file:line` + one-line summary); clicking a note expands to the rich
  view — the screenshot(s) + text-output snippets inline. (Hot Sheet renders the
  artifacts on click, a deliberate, maintainer-approved exception to the docs/110
  §110.6 "does not render notes" non-goal, scoped to proof artifacts.)
- **Q3 — Gating → (b) presence-gated.** The section appears whenever
  ticket-matching notes exist in `.pr-notes/`, independent of the `aiReviewNotes`
  inducement toggle (docs/110 §110.4) — reading existing proof shouldn't require
  the author-side switch.

## 111.3 The SARIF read (Glassbox docs/20 §20.2)

Each shard is SARIF 2.1.0; **one `result` = one note**. Fields Hot Sheet reads:

| Datum | SARIF field |
| --- | --- |
| Linked ticket | `result.workItemUris[]` — `glassbox note add --ticket X` stores `X` verbatim (an id like `HS-1234`, or a URL) |
| Anchor file | `result.locations[0].physicalLocation.artifactLocation.uri` |
| Anchor lines | `…region.startLine` / `.endLine` |
| Summary | first line of `result.message.text` |
| Kind | `result.properties.tags[0]` (`proof` / `rationale` / `risk` / …) |
| Importance | `result.rank` (0–100) → sort; `result.level` |
| Attachments | `result.attachments[].artifactLocation.uri` (+ `.description.text`); text inline, screenshots under `.pr-notes/artifacts/` via **Git LFS** |

**Ticket matching (no false matches).** A note matches when a `workItemUri`
contains the ticket number as a whole token — a `(?<![\w-])HS-1234(?![\w-])`
boundary match, so `HS-12` never matches `HS-123` / `HS-1234` (the ticket's stated
requirement), while a URL ending in the id still matches.

## 111.4 Phasing

- **Phase 1 — reader (SHIPPED, HS-9223).** `src/reviewNotes/prNotesReader.ts`:
  `readReviewProofForTicket(gitRoot, ticketNumber) → ReviewProofNote[]`. Pure over
  a passed repo root (trivially testable); scans `.pr-notes/notes/**/*.sarif`,
  zod-validates a tolerant SARIF subset, matches by ticket, maps to display
  metadata + typed (`image`/`text`) attachment refs, most-important first. Skips a
  malformed shard; returns `[]` when `.pr-notes/` is absent. Tests:
  `prNotesReader.test.ts` (match, cross-ticket isolation, HS-12≠HS-123 boundary,
  URL work-item, malformed-shard tolerance, missing-dir, rank sort, bare/attachless
  results).
- **Phase 2 — API + client light list (SHIPPED, HS-9293).**
  - **Endpoint:** `GET /tickets/:number/review-proof` (`src/routes/tickets.ts`) →
    `{ notes }`. Resolves the repo root via `getGitRoot(projectRootFromDataDir(dataDir))`
    (same as `routes/git.ts`) and calls the reader. Wire shape once in
    `src/api/reviewProof.ts` (`getReviewProof` caller); `reviewProofRoute.test.ts`.
  - **Detail-panel section:** `src/client/reviewProofSection.tsx` renders the
    "Review Proof (N)" block into `#detail-review-proof` (added to `pages.tsx`,
    driven by `loadDetail` in `detail.tsx`, mirroring `ticketTelemetryStats`).
    Presence-gated (`:empty`-collapses); each note row shows kind + `file:line` +
    summary and **expands on click** to its attachment chips (name + image/text
    icon + description). Poll-safe: cached per ticket, repainted only on change, so
    a background reload never flashes or collapses an expanded row.
    `reviewProofSection.test.ts`.
- **Phase 3 — inline rich artifacts + Open-in-Glassbox (FOLLOW-UP).** Swap the
  attachment CHIPS for the real inline render (Q2 "b"): an LFS-aware artifact-serving
  route that streams a real image from `.pr-notes/artifacts/` (or a "not pulled /
  open in Glassbox" chip when the file is still an LFS pointer stub) + text-artifact
  inlining, plus a per-note "Open in Glassbox" (reusing `launchGlassbox`) that jumps
  to the anchored `file:line`.

## 111.5 Non-goals (inherited from docs/110 §110.6)

- Hot Sheet does not author `.pr-notes/`, own the SARIF format, or re-specify note
  kinds. It reads a tolerant subset and treats unknown fields as opaque.
- Beyond the Q2 proof-artifact display, Hot Sheet does not become a general SARIF
  viewer — the full note view stays in Glassbox (§20.6).
