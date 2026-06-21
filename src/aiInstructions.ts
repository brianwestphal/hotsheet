/**
 * HS-8913 — Hot Sheet's recommended AI-assistant instruction sections.
 *
 * Hot Sheet works best when the project's AI assistant (Claude Code, etc.)
 * knows three conventions: drive work through Hot Sheet tickets, keep double
 * test coverage, and keep human + AI-oriented requirements docs in sync. This
 * module owns the canonical text for those sections and the logic to install /
 * update them in a project's `CLAUDE.md`.
 *
 * Each section is written between versioned HTML-comment markers so we can:
 *   - detect whether it's present (and at what version),
 *   - auto-update the PRESCRIBED part when we improve the wording, WITHOUT
 *     clobbering anything the user wrote around it,
 *   - and carry a nested, self-healing "this project's specifics" sub-block.
 *
 * The specifics sub-block ships with a `hotsheet:needs-setup` sentinel + an
 * instruction telling the reading AI to detect the project's tooling, confirm
 * with the user, and replace the block (removing the sentinel). While the
 * sentinel is present the block is treated as UNFILLED and may be refreshed by
 * an update; once the agent removes it the block is the user's and is preserved
 * verbatim forever. This keeps the prescribed principles portable across any
 * project while letting the per-project mechanics (test runner, docs layout,
 * commands) be filled in correctly for any language with no detection code here.
 *
 * v1 targets `CLAUDE.md` only (Claude Code). Cursor / Windsurf / Copilot
 * variants are HS-8916. The pure string transforms here are reused there.
 *
 * Design: docs/86-ai-assistant-setup.md.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { isExecutableOnPath } from './utils/isExecutableOnPath.js';

/** One managed section. `version` is the prescribed-content version (bumped
 *  when we improve the wording — triggers an auto-update). `specifics`, when
 *  present, is the self-healing per-project sub-block scaffold. */
export interface ManagedSection {
  id: string;
  /** Prescribed, project-agnostic content (the `## Heading` + body). */
  prescribed: string;
  version: number;
  /** Optional self-healing "this project's specifics" sub-block scaffold
   *  (content placed between the specifics markers when first installed). */
  specifics?: string;
  /** Version of the specifics scaffold (refreshed only while still unfilled). */
  specificsVersion?: number;
}

/** Sentinel inside a freshly-scaffolded specifics block. The reading AI is
 *  instructed to remove it once it fills the block; its presence == unfilled. */
export const NEEDS_SETUP_SENTINEL = '<!-- hotsheet:needs-setup -->';

const TICKET_DRIVEN_WORK = `## Ticket-Driven Work

When the user gives you work directly (not via the Hot Sheet channel or events), create Hot Sheet tickets before starting implementation — especially for substantial or multi-step work.

- **Do create tickets** for: features, bug fixes, refactoring, multi-step tasks, anything changing code. **Don't** for: simple questions, git commits, quick lookups, trivial one-liners. **When in doubt, create them.**
- Create via the Hot Sheet API (prefer the \`hotsheet_*\` MCP tools), mark Up Next, then work through them: set status \`started\` → implement → set \`completed\` with notes.
- **Always create follow-up tickets** for incomplete work (unfinished steps, open design questions, known gaps, designed-but-unbuilt features). If it's not in a ticket, it's forgotten.
- **Incomplete-work checklist** — before marking a ticket \`completed\`, file follow-ups for any: (1) UI placeholder text ("coming soon"), (2) TODO/FIXME comments, (3) documented-but-unimplemented requirements, (4) empty/stub functions returning mock data.
- **Use FEEDBACK NEEDED before deferring or asking about follow-ups.** When about to (a) defer a ticket needing more work, (b) ask whether to file follow-ups, or (c) close with a question buried in notes — DON'T. Leave the ticket \`started\`, add a \`FEEDBACK NEEDED:\` note (per \`.hotsheet/worklist.md\`), signal channel done, and wait. It's the only reliable way to surface a question.`;

const TESTING_PHILOSOPHY = `## Testing Philosophy

- **Double coverage**: every feature covered by both unit tests AND E2E tests. Unit = logic in isolation; E2E = real user flows through the running app with minimal mocking.
- **Unit tests**: Mock external deps (filesystem, network), test real logic.
- **E2E tests**: As much as possible, use test automation tools to run realistic, user-facing flows. Minimize mocks.
- **Coverage**: Merge all test coverage (e.g. unit, E2E server, E2E browser) into one report. Low-coverage files should get more of both test types. Aim for 100% coverage of code lines, 100% coverage of branches, and 100% of features described in the requirements documentation.
- **Manual test plan**: keep a manual test plan doc (e.g. \`docs/manual-test-plan.md\`) for features that can't be reliably automated. **Keep it up to date** — add such features there; when you add automated coverage for a previously-manual item, remove it and note it in an "Automated Coverage Summary".
- **Always fix lint and type errors before finishing**: Fix as you go, don't batch.`;

const TESTING_SPECIFICS = `### This project's test setup
${NEEDS_SETUP_SENTINEL}

> ⚙️ **Setup needed — fill this in once.**
> The test specifics for this project haven't been recorded yet. The next time you (an AI assistant) are about to write tests, run tests, or set up CI:
> 1. **Detect** what you can from the project's config (\`package.json\`, \`pyproject.toml\`, \`Cargo.toml\`, \`go.mod\`, \`Makefile\`, CI files).
> 2. **Ask the user to confirm and fill gaps** — especially tools they *plan* to use but haven't installed yet: the unit and E2E/integration test runner(s); where tests live (paths/globs); the commands to run unit tests, E2E tests, and a merged coverage report; and any shared test helpers to always use.
> 3. **Replace everything between the two \`hotsheet:specifics\` markers** (including the \`hotsheet:needs-setup\` line above) with the filled-in specifics, e.g.:
>    - **Unit tests** (\`<glob>\`): \`<runner>\`. \`<helpers>\`.
>    - **E2E tests** (\`<glob>\`): \`<framework>\`. \`<how they run>\`.
>    - **Commands**: unit \`<cmd>\` · E2E \`<cmd>\` · coverage \`<cmd>\`.
>
> Once the \`hotsheet:needs-setup\` line is gone, this prompt won't appear again.`;

const REQUIREMENTS_DOCUMENTATION = `## Requirements Documentation

Keep human-readable requirements documents as the source of truth for what the project does, and **keep them up to date in the same change as the code** (add/remove/modify a requirement → update its doc). Create new docs for major new functional areas. Cross-reference related docs with relative links.

### AI Summaries

Maintain two synthesis docs an AI assistant reads at the start of a fresh session — keep them in sync with reality (source doc/code wins on conflict), and prefer small targeted edits over rewrites:

- A **codebase map** — directory tree, entry points, data schema, build, tests, settings, and a "where do I look for X" index. Update it in the same change when you add a file or directory, add a route/endpoint, change the schema, add a client module, or add a setting key.
- A **requirements summary** — a synthesized view of every requirements doc with status markers (e.g. Shipped / Partial / Design only / Deferred). Update it in the same change when you add a requirements doc, ship a design-only feature, or defer/regress a shipped one.`;

const REQUIREMENTS_SPECIFICS = `### This project's docs layout
${NEEDS_SETUP_SENTINEL}

> ⚙️ **Setup needed — fill this in once.**
> Where this project keeps its requirements docs and AI-summary files hasn't been recorded yet. The next time you (an AI assistant) work with the docs:
> 1. **Detect** the existing docs layout (e.g. a \`docs/\` folder, a wiki, numbered files) and whether codebase-map / requirements-summary files already exist.
> 2. **Ask the user to confirm** the docs location, the file-naming convention, and the exact paths of the codebase-map and requirements-summary files (create them if they don't exist and the user wants them).
> 3. **Replace everything between the two \`hotsheet:specifics\` markers** (including the \`hotsheet:needs-setup\` line above) with the filled-in specifics — the docs folder, the naming convention, and the two summary-file paths.
>
> Once the \`hotsheet:needs-setup\` line is gone, this prompt won't appear again.`;

/** The canonical recommended sections, in install order. */
export const MANAGED_SECTIONS: ManagedSection[] = [
  { id: 'ticket-driven-work', prescribed: TICKET_DRIVEN_WORK, version: 1 },
  { id: 'testing-philosophy', prescribed: TESTING_PHILOSOPHY, version: 1, specifics: TESTING_SPECIFICS, specificsVersion: 1 },
  { id: 'requirements-documentation', prescribed: REQUIREMENTS_DOCUMENTATION, version: 1, specifics: REQUIREMENTS_SPECIFICS, specificsVersion: 1 },
];

// --- Marker helpers ---

function sectionBegin(id: string, v: number): string { return `<!-- hotsheet:begin section=${id} v=${v} -->`; }
function sectionEnd(id: string): string { return `<!-- hotsheet:end section=${id} -->`; }
function specificsBegin(id: string, v: number): string { return `<!-- hotsheet:begin specifics=${id} v=${v} -->`; }
function specificsEnd(id: string): string { return `<!-- hotsheet:end specifics=${id} -->`; }

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Matches a whole section block; captures [1]=version, [2]=inner content. */
function sectionRe(id: string): RegExp {
  return new RegExp(
    `<!-- hotsheet:begin section=${escapeRe(id)} v=(\\d+) -->\\n([\\s\\S]*?)\\n<!-- hotsheet:end section=${escapeRe(id)} -->`,
  );
}

/** Matches the specifics sub-block within a section's inner content;
 *  captures [1]=version, [2]=inner content. */
function specificsRe(id: string): RegExp {
  return new RegExp(
    `<!-- hotsheet:begin specifics=${escapeRe(id)} v=(\\d+) -->\\n([\\s\\S]*?)\\n<!-- hotsheet:end specifics=${escapeRe(id)} -->`,
  );
}

/** Build a fresh specifics block (markers + scaffold) for a section. */
function freshSpecificsBlock(def: ManagedSection): string {
  return `${specificsBegin(def.id, def.specificsVersion ?? 1)}\n${def.specifics ?? ''}\n${specificsEnd(def.id)}`;
}

/**
 * Build the full text for a section. When `existingInner` is provided (an
 * update of an already-present section), a FILLED specifics block in it is
 * preserved verbatim; an unfilled one (or none) is (re)scaffolded.
 */
function buildSection(def: ManagedSection, existingInner: string | null): string {
  let body = def.prescribed;
  if (def.specifics !== undefined) {
    let specificsBlock = freshSpecificsBlock(def);
    if (existingInner !== null) {
      const m = existingInner.match(specificsRe(def.id));
      // Preserve the user's filled-in block: present AND no needs-setup sentinel.
      if (m !== null && !m[0].includes(NEEDS_SETUP_SENTINEL)) {
        specificsBlock = m[0];
      } else if (m === null && !existingInner.includes('hotsheet:specifics')) {
        // No specifics markers at all in an existing section we control: the
        // user removed them deliberately — don't re-add (avoid nagging).
        specificsBlock = '';
      }
    }
    body = specificsBlock === '' ? def.prescribed : `${def.prescribed}\n\n${specificsBlock}`;
  }
  return `${sectionBegin(def.id, def.version)}\n${body}\n${sectionEnd(def.id)}`;
}

// --- Pure apply / detect ---

export interface SectionStatus {
  id: string;
  present: boolean;
  /** Installed prescribed version (null when absent). */
  version: number | null;
  /** True when present but the installed version is behind the current one. */
  outdated: boolean;
  /** True when the section's specifics sub-block still carries the
   *  needs-setup sentinel (i.e. the agent hasn't filled it in yet). */
  needsSetup: boolean;
}

export interface InstructionsStatus {
  sections: SectionStatus[];
  /** Any section absent. */
  missing: boolean;
  /** Any present section behind the current prescribed version. */
  outdated: boolean;
  /** missing || outdated — i.e. writing would change something material. */
  setupNeeded: boolean;
}

/** Inspect existing CLAUDE.md text (or '' when the file is absent). */
export function getInstructionsStatus(existing: string): InstructionsStatus {
  const sections = MANAGED_SECTIONS.map((def): SectionStatus => {
    const m = existing.match(sectionRe(def.id));
    if (m === null) {
      return { id: def.id, present: false, version: null, outdated: false, needsSetup: false };
    }
    const version = Number(m[1]);
    const inner = m[2];
    const needsSetup = def.specifics !== undefined && inner.includes(NEEDS_SETUP_SENTINEL);
    return { id: def.id, present: true, version, outdated: version < def.version, needsSetup };
  });
  const missing = sections.some(s => !s.present);
  const outdated = sections.some(s => s.outdated);
  return { sections, missing, outdated, setupNeeded: missing || outdated };
}

/**
 * Apply the managed sections to existing CLAUDE.md text. Present sections are
 * rewritten in place (preserving filled specifics); absent sections are
 * appended. Returns the new content and whether anything changed.
 */
export function applyManagedSections(existing: string): { content: string; changed: boolean } {
  let content = existing;
  let changed = false;

  for (const def of MANAGED_SECTIONS) {
    const re = sectionRe(def.id);
    const m = content.match(re);
    if (m !== null) {
      const rebuilt = buildSection(def, m[2]);
      if (rebuilt !== m[0]) {
        // Replace via a function so `$`-sequences in the markdown (rebuilt) are
        // treated literally, not as replacement patterns.
        content = content.replace(m[0], () => rebuilt);
        changed = true;
      }
    } else {
      const block = buildSection(def, null);
      content = appendBlock(content, block);
      changed = true;
    }
  }

  return { content, changed };
}

/** Append a managed block to existing content, separated by a blank line. */
function appendBlock(existing: string, block: string): string {
  const trimmed = existing.replace(/\s+$/, '');
  if (trimmed === '') return block + '\n';
  return `${trimmed}\n\n${block}\n`;
}

// --- Filesystem layer (CLAUDE.md) ---

/** Path to a project's root CLAUDE.md. */
export function claudeMdPath(projectRoot: string): string {
  return join(projectRoot, 'CLAUDE.md');
}

/** Read CLAUDE.md, or null when absent / unreadable. */
export function readClaudeMd(projectRoot: string): string | null {
  const path = claudeMdPath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch (err: unknown) {
    if (err instanceof Error) console.warn(`[ai-instructions] Failed to read CLAUDE.md in ${projectRoot}: ${err.message}`);
    return null;
  }
}

/**
 * Is Claude Code the AI tool for this project? True when the `claude` CLI is on
 * PATH, the project has a `.claude/` dir, or a CLAUDE.md already exists. Used to
 * gate the once-per-project setup nudge (no point prompting a non-Claude user).
 */
export function isClaudeProject(projectRoot: string): boolean {
  return (
    isExecutableOnPath('claude') ||
    existsSync(join(projectRoot, '.claude')) ||
    existsSync(claudeMdPath(projectRoot))
  );
}

export interface AiInstructionsState extends InstructionsStatus {
  /** Whether Claude Code is detected for this project. */
  detected: boolean;
  /** Whether a CLAUDE.md file currently exists. */
  fileExists: boolean;
}

/** Read the project's CLAUDE.md and report install/update status + detection. */
export function getAiInstructionsState(projectRoot: string): AiInstructionsState {
  const existing = readClaudeMd(projectRoot);
  const status = getInstructionsStatus(existing ?? '');
  return { ...status, detected: isClaudeProject(projectRoot), fileExists: existing !== null };
}

/**
 * Install / update the managed sections in the project's CLAUDE.md. Creates the
 * file when absent. Returns whether the file was written (false when already
 * up to date) plus the post-write status.
 */
export function writeAiInstructions(projectRoot: string): { written: boolean; state: AiInstructionsState } {
  const existing = readClaudeMd(projectRoot) ?? '';
  const { content, changed } = applyManagedSections(existing);
  if (changed) {
    try {
      writeFileSync(claudeMdPath(projectRoot), content, 'utf-8');
    } catch (err: unknown) {
      if (err instanceof Error) console.warn(`[ai-instructions] Failed to write CLAUDE.md in ${projectRoot}: ${err.message}`);
    }
  }
  return { written: changed, state: getAiInstructionsState(projectRoot) };
}

/** Derive a project root from a `.hotsheet/` data dir. */
export function projectRootFromDataDir(dataDir: string): string {
  return dataDir.replace(/\/\.hotsheet\/?$/, '');
}
