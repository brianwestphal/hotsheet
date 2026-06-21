# 86. AI Assistant Setup (recommended instruction sections in CLAUDE.md)

**Status: SHIPPED** (HS-8913, 2026-06-21). v1 targets **Claude Code only**
(`CLAUDE.md`); Cursor / Windsurf / Copilot variants are deferred to HS-8916.

Hot Sheet works best when a project's AI assistant follows three conventions:
drive work through Hot Sheet tickets, keep double test coverage, and keep
human + AI-oriented requirements docs in sync. This feature ships the canonical
text for those conventions and the machinery to install + keep it current in a
project's `CLAUDE.md`.

## 86.1 The three recommended sections

The canonical text lives in `src/aiInstructions.ts` (`MANAGED_SECTIONS`). Each
section is project-agnostic on purpose — useful to an AI in any codebase, not
tied to Hot Sheet's own repo layout:

1. **Ticket-Driven Work** — when to create tickets, the `started → completed`
   lifecycle, always filing follow-ups, and using `FEEDBACK NEEDED` before
   deferring. (Prescribed only; nothing project-local.)
2. **Testing Philosophy** — double coverage, minimize mocks in E2E, merge
   coverage toward 100%, keep a manual test plan, fix lint/type errors as you go.
   (Prescribed principles + a self-healing specifics block — see §86.3.)
3. **Requirements Documentation** — keep human-readable requirements docs as the
   source of truth, and maintain a codebase-map + requirements-summary the AI
   reads each session. (Prescribed principles + a self-healing specifics block.)

The README ([../README.md](../README.md) → "Recommended project instructions")
publishes all three as copy-paste blocks for users who'd rather add them by hand.

## 86.2 Managed-section markers + versioning

Each section is written between versioned HTML-comment markers so Hot Sheet can
detect it, update it, and never clobber the user's surrounding file:

```
<!-- hotsheet:begin section=testing-philosophy v=1 -->
## Testing Philosophy
…prescribed principles…
<!-- hotsheet:begin specifics=testing-philosophy v=1 -->
…self-healing specifics block…
<!-- hotsheet:end specifics=testing-philosophy -->
<!-- hotsheet:end section=testing-philosophy -->
```

- **Detection** = section markers present. `getInstructionsStatus(existing)`
  reports, per section, whether it's `present`, its installed `version`, whether
  it's `outdated` (installed version < current), and whether its specifics block
  still `needsSetup` (§86.3).
- **Auto-update** = when we improve the wording we bump the section's `version`;
  `applyManagedSections(existing)` rewrites the **prescribed** portion in place
  for any section behind the current version, leaving everything around it (and
  any filled-in specifics) untouched. Absent sections are appended.
- The whole thing is **idempotent**: applying when already current changes
  nothing (`changed: false`).

Pattern mirrors `src/gitignore.ts`'s managed `.hotsheet/` block, generalized to
multiple versioned regions.

## 86.3 Self-healing "this project's specifics" blocks

Generic test/docs prose has weak teeth — the high-value bits (test runner, file
globs, the command to run coverage, the docs layout) are exactly the parts that
can't be prescribed because they vary per project. So instead of shipping inert
placeholders, the specifics block ships a **self-healing prompt**: it carries a
`<!-- hotsheet:needs-setup -->` sentinel plus an instruction telling the reading
AI to (1) detect what it can from the project's config, (2) confirm with the
user and ask about tools they *plan* to use, then (3) replace the block —
removing the sentinel.

This makes the per-project tailoring work for **any language** with zero
detection code in Hot Sheet: the agent already reading the file is the best
positioned detector. State transitions:

- **Unfilled** (`hotsheet:needs-setup` present) → may be refreshed by an
  auto-update (so we can improve the onboarding prompt for projects that haven't
  onboarded yet).
- **Filled** (agent removed the sentinel) → the block is the user's; preserved
  **verbatim forever**, even when the section's prescribed version bumps.
- **Deleted** (user removed the specifics markers entirely) → not re-added (no
  nagging).

`needsSetup` in the status surface reflects whether any specifics block is still
unfilled (informational; it does not by itself trigger the nudge — see §86.4).

## 86.4 Install triggers

Three ways the sections get into `CLAUDE.md`:

1. **Once-per-project nudge** (`src/client/aiInstructionsNudge.tsx`,
   `maybeShowAiInstructionsNudge()` at app boot). Decision logic
   (`decideNudgeAction`):
   - If **some** managed sections are already present but `setupNeeded` (a section
     is outdated, or a newly-added section is missing) → **silently auto-update**,
     no prompt. The user already opted in; we just keep the text current.
   - If **no** managed sections are present → show the prompt, gated on Claude
     being detected for the project (`isClaudeProject` — `claude` on PATH, a
     `.claude/` dir, or an existing `CLAUDE.md`) **and** a per-project
     `ai_instructions_nudge_dismissed` flag in `settings.json`. Any dismissal
     (Set up / Not now / X / backdrop) sets the flag, so the prompt is genuinely
     once per project.
2. **Settings → General → "Update CLAUDE.md"** button — installs or updates the
   sections on demand, always available (even after the nudge is dismissed).
3. **README copy-paste** — for manual adoption.

## 86.5 API + code map

- **`src/aiInstructions.ts`** — section content, marker/versioning logic, the
  pure `getInstructionsStatus` / `applyManagedSections`, and the filesystem layer
  (`readClaudeMd`, `isClaudeProject`, `getAiInstructionsState`,
  `writeAiInstructions`, `projectRootFromDataDir`).
- **`src/routes/aiInstructions.ts`** — `GET /api/ai-instructions/status`,
  `POST /api/ai-instructions/apply` (active-project scoped via `dataDir`).
- **`src/api/aiInstructions.ts`** — typed callers + wire schemas
  (`getAiInstructionsStatus`, `applyAiInstructions`).
- **`src/client/aiInstructionsNudge.tsx`** — boot nudge + dialog.
- **`src/client/settingsDialog.tsx`** — the Settings → General button binding.

## 86.6 Scope + follow-ups

- v1 is **Claude Code / `CLAUDE.md` only**. Cursor (`.cursor/rules/*.mdc`),
  Windsurf (`.windsurf/rules/`), and Copilot (`.github/copilot-instructions.md`)
  variants reuse the same section content + marker logic — **HS-8916**.
- Hot Sheet does **not** ship per-language tooling auto-detection; the
  self-healing specifics block delegates that to the reading agent (§86.3).

## 86.7 Testing

- **Unit** — `src/aiInstructions.test.ts` (install / idempotence / status /
  outdated update / filled-specifics preservation / user-deleted-specifics /
  surrounding-content preservation + the fs layer) and
  `src/client/aiInstructionsNudge.test.ts` (decision matrix + dialog
  render/dismiss/CTA).
- **E2E** — `e2e/ai-instructions.spec.ts` drives `apply` against a temp project
  and asserts the markers land in `CLAUDE.md`.
