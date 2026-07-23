# 122 — Code Review Section (aggregate ticket review in Glassbox)

> **Status: server discovery SHIPPED (HS-9392, 2026-07-23); client rename + aggregate button (HS-9393) in progress.** The HS-9389 investigation's proposal, maintainer-approved: replace the per-note "Open in Glassbox" as the section's primary affordance with ONE aggregate button that reviews **all of a ticket's changes** (Glassbox shows the associated `.pr-notes/` proof items inline for free).
>
> Cross-refs: [111-review-proof-artifacts.md](111-review-proof-artifacts.md) (the section this evolves — reader/API/inline artifacts/per-note deep-links), [110-ai-review-notes-inducement.md](110-ai-review-notes-inducement.md) (how the notes get authored), [48-git-status-tracker.md](48-git-status-tracker.md) (repo-root resolution), [89-git-worktrees.md](89-git-worktrees.md) (worker `integration_branch` flow).

## 122.1 Problem

The docs/111 "Review Proof" section carries one "Open in Glassbox" per note —
there's no way to open **the ticket's whole change** for review, and the section
only exists when notes exist. The maintainer's ask (HS-9389): rename to "Code
Review", one aggregate button, linear commit runs reviewed as a single range,
interleaved runs behind a chooser (or an earliest→latest span with an
unrelated-changes caveat).

## 122.2 Commit discovery (SHIPPED, HS-9392)

`src/reviewNotes/ticketCommits.ts` + `GET /api/tickets/:number/commits`
(`src/api/ticketCommits.ts` — `getTicketCommits`):

- **Subject-line matching only** (word-boundary, case-insensitive). The HS-9389
  investigation showed commit BODIES routinely cross-reference other tickets
  ("Follow-up from HS-9384") whose diffs are unrelated — the leading `HS-NNNN:`
  subject convention is the authorship signal. Body-only mentions are excluded.
- **Linear grouping:** commits mapped to their positions in the bounded log
  (window: 2,000 commits); consecutive positions cluster into a group
  `{from: oldest^, to: newest, count, subjects, dates}`. Groups are returned
  newest-first.
- **Span:** with ≥2 interleaved groups, the overall
  `{from: earliest^, to: latest, unrelatedCount}` — the chooser's "review all"
  option, with the honest unrelated-commit count.
- **Integration branch:** a pending-integration worker ticket's
  `integration_branch` is also searched (`getTicketMetaByNumber`); commits not
  on HEAD form `ref`-labeled groups (missing branch tolerated).
- **`dirty` + `ticketStatus`** ride along for the client's started-ticket
  "review uncommitted changes" fallback.
- **Non-blocking + cached:** async `GitRunner` spawns (shared with
  `worktrees.ts`; load-resilience P1); results cached per (repo, ticket) keyed
  on HEAD/branch tips — an unmoved tip skips the log walk (dirtiness is
  re-probed). Non-repo projects / git failures return the empty shape.

## 122.3 Client (HS-9393)

- Rename "Review Proof (N)" → **"Code Review"** (note count moves into the body).
- Header-level aggregate **Open in Glassbox**: 1 group → `mode:'range'`
  (single commit → `mode:'commit'`); ≥2 groups → chooser (per-group subjects +
  dates, plus "Review all, earliest→latest" with the unrelated-count caveat);
  no commits + `started` + dirty → "Review uncommitted changes"
  (`mode:'uncommitted'` → `glassbox --uncommitted`); no commits at all → the
  files-mode aggregate over note-anchored files.
- Presence rule widens to **notes OR commits** (a note-less ticket with commits
  still gets the button).
- Per-note deep-links stay in expanded rows (secondary affordance).

## 122.4 Implications recorded (HS-9389)

Interleaved ticket commits are the NORM in this workflow (sessions interleave
tickets), so the chooser is essential. Squash-merges survive discovery when the
squash subject keeps the `HS-NNNN:` ref. SARIF `versionControlProvenance`
points at the *parent* of the change's commit (notes are authored pre-commit) —
a hint, not the commit set. Tickets older than the log window fall back to the
notes-files aggregate.

## 122.5 Testing

- `ticketCommits.test.ts` — pure core (word-boundary subject matching,
  contiguous vs interleaved grouping, span/unrelated counts, log parsing) +
  real-temp-git fixtures (body-mention exclusion, ref-labeled branch groups,
  missing branch tolerated, tip-keyed cache behavior, dirty flag, non-repo).
- Client/E2E coverage lands with HS-9393 (chooser render, range POST).
