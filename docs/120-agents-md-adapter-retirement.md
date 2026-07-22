# 120. Retiring Grandfathered Full-Section AGENTS.md Duplicates

> **Status: Shipped (HS-9375, 2026-07-22).** The HS-9358 L3 "retire the previous
> tool's stale files" slice, scoped to the HS-9366 grandfathering rule
> ([118-adapter-mode-tool-config.md](118-adapter-mode-tool-config.md) §118.3).
> Rides the HS-9367 ask-first surface
> ([119-tool-switch-config-prep.md](119-tool-switch-config-prep.md)).

## 120.1 Problem

HS-9366's adapter mode grandfathered any AGENTS-family file that already carried
the FULL managed sections: converting it would delete our marker blocks —
including a possibly user-**filled** specifics sub-block — so such files stayed
in full (duplicated) mode forever.

## 120.2 The safety invariant

Conversion may only delete content that is **scaffold** (the specifics block
still carries the `hotsheet:needs-setup` sentinel) or **preserved in CLAUDE.md**
(an identical filled block, or one migrated there first). Anything else blocks
conversion.

## 120.3 The three outcomes (`planAdapterConversion`, `src/aiInstructions.ts`)

Per present full section, compare the AGENTS-family file's specifics state with
canonical CLAUDE.md's:

| Outcome | Condition | Behavior |
|---|---|---|
| **lossless** | every filled state is scaffold/absent (or identical to CLAUDE.md's filled block) | **Automatic**: `writeInstructionsForTool` strips the full sections (`removeManagedSections`) and installs the thin adapter in the same write. Reached via any normal write path — the §86 silent-update, `/apply`, or tool-prep — because `sectionSetFor` reports the ADAPTER set for such files (their "missing adapter section" makes `setupNeeded` true). |
| **migratable** | ≥1 filled block whose CLAUDE.md counterpart is unfilled/absent | **Ask-first** (HS-9367 dialog): `getToolPrepStatus.conversionOffered` = true → the prep dialog discloses the conversion ("your filled-in specifics move into `CLAUDE.md` first, so nothing is lost"); on accept, `prepareToolConfig` → `convertToolFileToAdapter` migrates the filled block(s) into CLAUDE.md (`convertBodyToAdapter` — CLAUDE.md gains the managed sections if absent, its unfilled block is replaced by the filled one), strips, installs the adapter. Writes both files. |
| **conflict** | ≥1 filled block that DIFFERS from a filled CLAUDE.md block | **Never converted automatically** — the file stays full-mode and nothing is offered; the user must reconcile the two versions by hand (or via the follow-up merge flow, HS-9378). |

## 120.4 Wiring

- `src/aiInstructions.ts` — pure core: `sectionSpecificsState` (absent /
  no-specifics / unfilled / filled + the block text), `removeManagedSections`,
  `planAdapterConversion`, `convertBodyToAdapter` (throws on conflict).
- `src/aiInstructionsTools.ts` — `sectionSetFor` now returns
  `{sections, stripFullSections}` (lossless → adapter + strip);
  `adapterConversionPlanFor(root, tool)` (null when retirement doesn't apply);
  `convertToolFileToAdapter(root, tool)` (the migratable file-level op,
  frontmatter-preserving, refuses conflicts).
- `src/toolPrep.ts` — `ToolPrepStatus.conversionOffered` (migratable only);
  `prepareToolConfig` performs the conversion before the normal write.
- Wire: `ToolPrepStatusSchema.conversionOffered` (optional — pre-HS-9375
  server compatible); client `decideToolPrepAction` dialogs on
  `needed || conversionOffered`; the dialog gains the disclosure bullet.

## 120.5 Non-goals / deferred

- **Conflict merge UI** — diffing a conflicting filled block against CLAUDE.md's
  and merging interactively (the other half of the L3 "diff managed sections for
  drift" idea) — follow-up HS-9378.
- Only AGENTS-family files retire — Cursor/Windsurf/Copilot have no adapter mode
  to retire into (docs/118 scope).
- Skills need no retirement: `.agents/skills` files are wholly Hot Sheet-owned,
  so the HS-9366 `SKILL_VERSION` bump already rewrites them as adapters.

## 120.6 Tests

- `aiInstructionsTools.test.ts` — lossless auto-retire (unfilled full-mode file →
  adapter, idempotent), filled → stays full + plan `migratable`,
  `convertToolFileToAdapter` migrates into CLAUDE.md then retires, conflict
  refuses with both files untouched.
- `toolPrep.test.ts` — `conversionOffered` end-to-end through
  `prepareToolConfig` (offer → convert → post-status clean).
- `client/toolPrepNudge.test.ts` — decision table rows + the dialog disclosure.
