# 118. Adapter-Mode Per-Tool Config Generators (+ Codex)

> **Status: Shipped (HS-9366, 2026-07-22).** Foundational piece of the HS-9358
> tool-switching epic (L2); consumed by HS-9367 (auto-prepare config on an
> `ai_tool` switch). See [113-multi-ai-tool-support.md](113-multi-ai-tool-support.md)
> for the tool taxonomy.

## 118.1 Problem

Hot Sheet generates instruction files (`CLAUDE.md`, `AGENTS.md`, Cursor/Windsurf
rules, …) and skill trees (`.claude/skills`, `.agents/skills`) per AI tool. Before
this change, every tool's files carried **full duplicated content** — so a project
using Claude *and* an AGENTS-family tool (Antigravity, Codex, OpenCode) had two
diverging copies of the same guidance, and any hand-edit to one silently forked
the other. The maintainer's hand-built pattern in `~/Documents/video-studio`
solves this with **thin adapters**: the non-Claude files just point at the
canonical Claude files.

## 118.2 The adapter model (video-studio pattern)

When the project has a **canonical Claude source**, non-Claude AGENTS-family
config is generated as adapters:

- **`AGENTS.md`** — instead of duplicating the full §86 managed sections, a single
  managed section (`claude-adapter`, `ADAPTER_SECTIONS` in `src/aiInstructions.ts`)
  states: *"`CLAUDE.md` is the shared source of truth … read it completely and
  follow it as if its contents appeared here"*, plus a tiny tool-workflow list
  (skills live under `.agents/skills/`; adapters delegate to `.claude/skills/`;
  treat Claude tool names as capability labels; keep shared rules in `CLAUDE.md`).
  It is still a **marker-wrapped managed section**, so user content around it is
  preserved and updates are non-destructive, exactly like the full sections.
- **`.agents/skills/<name>/SKILL.md`** — keeps its own frontmatter (`name` +
  `description`, so tools can still discover/select the skill), body =
  *"Read `../../../.claude/skills/<name>/SKILL.md` completely and follow its
  workflow …"* (`adapterSkillBody` in `src/skills.ts`).

**Canonical-source gate** — `canonicalClaudeSourceExists(projectRoot)`
(`src/aiInstructions.ts`): BOTH `CLAUDE.md` **and** `.claude/skills` must exist.
One gate drives instructions *and* skills so the two never disagree (an adapter
`AGENTS.md` never points at skill adapters that don't exist).

**Fallback** — with no canonical source (a project that started on Codex), full
content is emitted exactly as before. Hot Sheet never *invents* a `.claude/` tree
for a non-Claude project.

**Freshness** — in adapter mode the generator refreshes the canonical
`.claude/skills` tree FIRST (even when the project's `ai_tool` excludes Claude),
so adapters can't reference stale canonical content (`ensureAgentsFamilySkills`).
Port/secret/worklist details live only in the canonical bodies.

## 118.3 Grandfathering (non-destructive)

An `AGENTS.md` that **already contains the full managed sections** (installed
pre-adapter-era) stays in full mode: converting it would delete our marker
blocks, including a possibly user-filled specifics sub-block. `sectionSetFor`
(`src/aiInstructionsTools.ts`) checks for any present full section before
choosing the adapter set. Retiring/converting those duplicates is the HS-9358
**L3** "retire stale files" work (follow-up ticket filed), out of scope here.

Similarly, `SKILL_VERSION` was bumped 22 → 23 so existing full-content
`.agents/skills` copies are rewritten as adapters on the next ensure pass (the
skill files are wholly Hot Sheet-owned, unlike `AGENTS.md`, so rewriting them is
safe).

## 118.4 Codex support (new)

Codex reads the `AGENTS.md` standard + `.agents/skills` (maintainer-confirmed;
the video-studio model *is* a Codex setup):

- **Instructions**: `codex` added to `AiInstructionTool` + the `TOOLS` table in
  `src/aiInstructionsTools.ts` (→ `AGENTS.md`; detect via `codex` on PATH ∥
  `AGENTS.md` present). Shares the file with the Antigravity/OpenCode entries —
  idempotent double-write.
- **Skills**: a `codex` branch in `ensureSkillsForDir` (`src/skills.ts`) seeds the
  same `.agents/skills` tree via the shared `ensureAgentsFamilySkills` (adapters
  when canonical exists, full otherwise). Platform label: `Codex`.
- `ai_tool: 'codex'` was already a valid selection (dropdown, `resolveCommand`);
  this closes its missing config generation.

## 118.5 Relative-path robustness

The skill adapter's reference path is FIXED at
`../../../.claude/skills/<name>/SKILL.md`: both trees are repo-root-anchored at
the same depth (`<root>/.agents/skills/<name>/` vs `<root>/.claude/skills/<name>/`),
and markdown paths use forward slashes on every OS — so no per-layout computation
is needed. If a future tool family stores skills at a different depth, its
adapter body must compute its own relative prefix (note for that future change).

## 118.6 Open questions / deferred

- **gemini / goose conventions** — codex + opencode read `AGENTS.md` (confirmed);
  gemini (`GEMINI.md`? `AGENTS.md`?) and goose (`.goosehints`?) need their real
  instruction/skill conventions researched before adapter-izing. Deferred with a
  follow-up ticket (HS-9366 sub-decision).
- **OpenCode skills** — OpenCode gets the adapter/full `AGENTS.md` (it was already
  in the TOOLS table) but no `.agents/skills` seeding yet; verify it reads that
  root before adding it to the codex branch (same follow-up ticket).
- **Retiring grandfathered full-section AGENTS.md files** — the HS-9358 L3 work
  (follow-up ticket filed).

## 118.7 Tests

- `aiInstructionsTools.test.ts` — adapter section written for AGENTS-family +
  canonical source; CLAUDE.md-alone is not canonical; full fallback; grandfathered
  full-mode file untouched; idempotence + user-content preservation; non-AGENTS
  tools unaffected; status not "missing" for adapter files; codex detection.
- `skillsAntigravity.test.ts` — codex seeds `.agents/skills` adapters (frontmatter
  kept, body delegated, canonical refreshed first); started-on-Codex full-body
  fallback (no `.claude/` invented); AGENTS.md-presence detection; antigravity
  shares the writer (ticket-skill adapters).
- `skills.test.ts` — HS-9311 selectivity updated (goose is now the representative
  generator-less agent).
