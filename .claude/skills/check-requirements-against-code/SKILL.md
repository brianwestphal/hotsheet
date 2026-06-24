---
name: check-requirements-against-code
description: Check requirements docs against implementation and report discrepancies
allowed-tools: Read, Grep, Glob, Bash, Agent
---

Comprehensively compare the requirements documents in `docs/` against the actual implementation. Also verify that the AI summary docs (`docs/ai/code-summary.md`, `docs/ai/requirements-summary.md`) and `CLAUDE.md` are in sync with both the requirements docs and the code. Generate a report with recommendations and questions about any discrepancies.

## Steps

1. **Read all requirements documents** in `docs/`. Note every stated requirement, behavior, and constraint. This includes the numbered docs (1, 2, 3, …) plus `plugin-development-guide.md`, `tauri-architecture.md`, `tauri-setup.md`, and `manual-test-plan.md`.

2. **For each requirement**, verify it against the implementation:
   - Search the codebase for the relevant code
   - Check if the behavior matches what's documented
   - Note any differences, missing features, or extra features not in the docs

3. **Check for undocumented features**: Scan the codebase for significant functionality that isn't covered by any requirements document. These are features that should either be documented or questioned.

4. **Check for stale documentation**: Requirements that describe behavior that no longer exists or has changed.

5. **Verify `CLAUDE.md` completeness**: Double-check that every requirements doc under `docs/` (numbered docs + `plugin-development-guide.md`, `tauri-architecture.md`, `tauri-setup.md`) appears in CLAUDE.md's "Reading order" list. Report any docs present on disk but missing from CLAUDE.md, or listed in CLAUDE.md but missing on disk.

6. **Synchronize `docs/ai/code-summary.md`**: Open the file and confirm each section still matches the current codebase. Flag any inaccuracy, then update the file in place. Check specifically:
   - §3 directory tree matches actual files under `src/` (use `Glob` to verify)
   - §4 routes catalog matches endpoints registered in `src/routes/`
   - §5 schema matches `CREATE TABLE` / `ALTER TABLE` statements in `src/db/connection.ts`
   - §8 channel section's `CHANNEL_VERSION` matches the constant in `src/channel.ts` (and `EXPECTED_CHANNEL_VERSION` in `src/channel-config.ts`)
   - §9 Tauri commands match `#[tauri::command]` functions in `src-tauri/src/lib.rs`
   - §12 settings/config file list matches what's actually written in `.hotsheet/` and `~/.hotsheet/`
   - §13 reverse-index entries still point to the correct files
   Make the edits as part of this check — do not just report them.

7. **Synchronize `docs/ai/requirements-summary.md`**: Open the file and confirm each entry still matches its source doc. Flag and update:
   - Any per-doc synthesis that no longer reflects the current doc (e.g., numbers, limits, or shipped-status changed)
   - Any newly-added requirements doc that isn't listed here
   - Any status change on the §14 dashboard (e.g., a Design-only feature has shipped; a Shipped feature has regressed or been deferred)
   - Any doc that has been superseded, renamed, or renumbered
   Make the edits as part of this check — do not just report them.

8. **Final consistency pass**: Make sure `CLAUDE.md`, `docs/ai/code-summary.md`, and `docs/ai/requirements-summary.md` agree with each other and with the source docs / code. Any disagreement gets resolved in favor of the source doc / code, and the summaries and `CLAUDE.md` are updated accordingly.

## Report Format

### Discrepancies Found

For each discrepancy:
- **Requirement**: Which doc, section number, and the stated requirement
- **Implementation**: What the code actually does (file path, line numbers)
- **Type**: `missing` (doc says X, code doesn't do X) | `different` (doc says X, code does Y) | `undocumented` (code does X, no doc mentions it) | `stale` (doc says X, feature was removed/changed)
- **Recommendation**: Should the doc be updated, or should the code be fixed?

### CLAUDE.md Coverage Audit

- Requirements docs on disk but missing from CLAUDE.md reading order
- Entries in CLAUDE.md reading order that no longer exist on disk
- Docs listed but mis-numbered or out of order

### AI Summary Synchronization

- **`docs/ai/code-summary.md`** — list of sections edited and why (or "no changes needed")
- **`docs/ai/requirements-summary.md`** — list of entries edited and why (or "no changes needed")

### Questions

List any ambiguous requirements where the implementation had to make a judgment call, and ask whether the current behavior is correct.

### Summary

- Total requirements checked
- Requirements fully implemented
- Discrepancies found (by type)
- Documentation gaps (CLAUDE.md and the two AI summaries)
- AI summary sections updated
