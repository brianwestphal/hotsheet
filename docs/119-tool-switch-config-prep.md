# 119. Prepare the Selected Tool's Config on an `ai_tool` Switch

> **Status: Shipped (HS-9367, 2026-07-22).** The L2 integration piece of the
> HS-9358 tool-switching epic, built on the HS-9366 adapter-mode generators
> ([118-adapter-mode-tool-config.md](118-adapter-mode-tool-config.md)). See
> [113-multi-ai-tool-support.md](113-multi-ai-tool-support.md) for the epic.

## 119.1 Problem

Changing the project's `ai_tool` (Settings → General) only re-ran skills
generation. The newly-selected tool's **instruction file** was never prepared —
so Claude → Codex left no `AGENTS.md` — and there was no signal that the
selected tool's config was absent or stale.

## 119.2 Behavior

- **On an `ai_tool` dropdown change** (`settingsDialog.tsx` → `maybeOfferToolPrep('switch')`):
  - Something **missing/stale** for the new tool → an **ask-first dialog**
    ("Prepare Codex Config?", reusing the §86 nudge surface/CSS) lists the files
    that would be written; one click runs the full prep. Nothing is silently
    committed to the repo on a dropdown change.
  - **Nothing needed** → silently `ensureSkills()` — the pre-HS-9367 refresh
    (e.g. installing/removing agy's `hooks.json` per the permission toggle) is
    preserved.
- **On project open** (the L1 drift fallback, folded in): `maybeShowAiInstructionsNudge`
  (boot + project switch) routes a project with an **explicit** `ai_tool` to the
  same prep check — once per project per session, gated by a per-project
  dismissal. A project with an explicit tool also **skips the generic
  "Add to CLAUDE.md" prompt** (its copy is wrong for, say, a Codex project);
  the silent §86 keep-current update still runs (the canonical `CLAUDE.md`
  serves every tool under adapter mode).
- **`auto` never prompts** — it keeps the detect-and-seed-everything behavior.

## 119.3 What "prepared" means (`src/toolPrep.ts`)

`getToolPrepStatus(projectRoot, dataDir)` for the selected tool:

- **Instructions** — the tool's instruction file state from
  `getInstructionsStatesForTools` (`setupNeeded` = missing ∥ outdated),
  evaluated against the section set the file SHOULD carry — **adapter-aware**
  (docs/118): a Codex project with a canonical Claude source is judged against
  the thin `claude-adapter` section, not the full sections.
- **Skills** — the tool's **main generated skill artifact**
  (`skillArtifactRelPath`: `.claude/skills/hotsheet/SKILL.md`,
  `.agents/skills/hotsheet/SKILL.md`, `.cursor/rules/hotsheet.mdc`,
  `.windsurf/rules/hotsheet.md`, `.github/prompts/hotsheet.prompt.md`) is absent
  or its `hotsheet-skill-version` header is behind `SKILL_VERSION`.
- Tools without an instruction convention or skill format (gemini / goose /
  opencode-skills — see HS-9374) contribute nothing; `auto` is never "needed".

`prepareToolConfig(projectRoot, dataDir, categories)` = `writeInstructionsForTool`
(adapter mode via docs/118) + `ensureSkillsForDir` (skills + MCP registration +
permissions/hooks, already narrowed to the selected tool by `wantsTool`). All
idempotent/non-destructive; a second run is a no-op. Ordering note: writing the
instruction file first means a fresh `AGENTS.md` satisfies the codex/antigravity
detection inside `ensureSkillsForDir` even when the tool binary isn't on PATH.

## 119.4 API + client

- `GET /api/ai-instructions/tool-prep` → `ToolPrepStatus` (`src/api/aiInstructions.ts`
  `getToolPrepStatus()`); `POST /api/ai-instructions/prepare-tool` → `ToolPrepResult`
  (`prepareToolConfig()`, run with the project's own categories per HS-8910).
- `src/client/toolPrepNudge.tsx` — `decideToolPrepAction(status, source, dismissedTool)`
  (pure): `auto`/nothing-needed → `silent-ensure` on switch / `none` on open;
  needed → `dialog`, except on `open` when dismissed for the SAME tool
  (`tool_prep_nudge_dismissed` file-setting stores the tool id, so switching to
  a different tool re-arms the nudge; an explicit dropdown switch always shows
  the dialog). Per-session once-per-project guard on the `open` path.
- **E2E seam:** the module honors the same `__HOTSHEET_DISABLE_AI_NUDGE__` flag
  as the §86 nudge (set by `e2e/coverage-fixture.ts`), so the dialog never
  intercepts clicks in unrelated specs — under the flag a `switch` falls back to
  the pre-HS-9367 silent `ensureSkills()` and `open` is inert.

## 119.5 Caveats / out of scope

- **Server startup still auto-seeds skills** for the selected tool
  (`ensureSkillsForAllProjects` → `wantsTool`) — pre-existing shipped behavior
  (agy, HS-9326). Ask-first therefore meaningfully gates the **instruction
  file** (user-ownable, committed); a declined skills prep will self-seed on the
  next server start. Documented, accepted.
- **L3 (deferred):** diffing managed sections for drift + retiring the previous
  tool's stale files — HS-9375 (and docs/118 §118.3 grandfathering).
- No silent-write preference toggle — ask-first is the default per the
  maintainer; adapters are thin/low-risk but still committed files.

## 119.6 Tests

- `src/toolPrep.test.ts` — artifact mapping, staleness (missing / version-behind /
  headerless / current), `auto`/goose need nothing, codex-on-empty needs both,
  prepare writes full-vs-adapter `AGENTS.md` + skills, idempotence.
- `src/client/toolPrepNudge.test.ts` — the decision table (switch/open ×
  needed/dismissed/auto), dialog rendering (label + only-needed files), CTA →
  `POST /ai-instructions/prepare-tool`, dismissal persistence, `open`-path
  once-per-session, silent-ensure on a no-op switch.
- Manual: the switch → confirm → files-written flow
  (`docs/manual-test-plan.md`).
