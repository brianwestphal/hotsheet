import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { z } from 'zod';

import { readFileSettings } from './file-settings.js';
import type { CategoryDef } from './types.js';
import { DEFAULT_CATEGORIES } from './types.js';
import { isExecutableOnPath } from './utils/isExecutableOnPath.js';

// HS-8022 bump — main /hotsheet skill body lost the conditional `/clear` prefix.
// HS-8348 — bumped 9 → 10 for the Phase 3 two-form skill rewrite. The
// `hs-*` ticket-skill body gains an MCP-tool-first / curl-fallback
// pattern; the `hotsheet` main-skill body gains the same two-form
// guidance. SKILL_VERSION bump forces existing seeded skill files to
// re-author on next boot via the `updateFile` upgrade path.
export const SKILL_VERSION = 10;

/**
 * HS-8390 — every long-lived mutable lifecycle ref this module owns lives
 * inside a single named container so a future audit can spot stale handles
 * immediately. Pre-fix the file carried three separately-declared module-level
 * `let`s (`skillPort` / `skillCategories` / `pendingCreatedFlag`), each with
 * its own implicit reset story across tests. Now: read `skillsState.foo`
 * everywhere; reset via `_resetSkillsStateForTesting()` (assigns
 * `freshSkillsState()`).
 *
 * This is the minimal-encapsulation variant of the HS-8390 ticket (vs. the
 * full per-project `SkillsContext` factory, which would require plumbing a
 * context through `projects.ts` + `routes/dashboard.ts` + every callsite —
 * deferred). The struct already gives us: (a) a single grep-able location
 * for every mutable bit, (b) explicit test-reset entry point, (c) a
 * straightforward path forward to the full factory if/when needed (rename
 * `skillsState` to a parameter, drop the module-level slot, expose a
 * `createSkillsContext()`).
 *
 * Note: `skillsState.port` is `number | undefined` — pre-fix `skillPort: number`
 * was declared without an initializer, so the runtime value WAS undefined
 * before `initSkills()` ran but the type lied. The `undefined` typing here
 * matches reality; `ticketSkillBody` and `ensureClaudePermissions` both
 * handle the `undefined` case explicitly now.
 */
interface SkillsState {
  port: number | undefined;
  categories: CategoryDef[];
  /**
   * Tracks whether skills were created/updated in this server session.
   * Consumed once by the UI endpoint so the banner shows even though
   * cli.ts already called ensureSkills() before the page loaded.
   */
  pendingCreatedFlag: boolean;
}

function freshSkillsState(): SkillsState {
  return {
    port: undefined,
    categories: DEFAULT_CATEGORIES,
    pendingCreatedFlag: false,
  };
}

let skillsState: SkillsState = freshSkillsState();

/** **HS-8390 — TEST ONLY.** Reset the module-level `skillsState` to its
 *  fresh shape so consecutive tests start from a clean slate. Production
 *  code never needs to call this; tests can call it in `beforeEach` as
 *  an explicit alternative to the implicit `initSkills` /
 *  `setSkillCategories` reset pattern. */
export function _resetSkillsStateForTesting(): void {
  skillsState = freshSkillsState();
}

export function initSkills(port: number) {
  skillsState.port = port;
}

export function setSkillCategories(categories: CategoryDef[]) {
  skillsState.categories = categories;
}

interface SkillDef {
  name: string;
  category: string;
  label: string;
  description: string;
}

function buildTicketSkills(): SkillDef[] {
  return skillsState.categories.map(cat => ({
    name: `hs-${cat.id.replace(/_/g, '-')}`,
    category: cat.id,
    label: cat.label.toLowerCase(),
    description: cat.description,
  }));
}

// --- Version tracking ---

function versionHeader(): string {
  return `<!-- hotsheet-skill-version: ${SKILL_VERSION} -->`;
}

export function parseVersionHeader(content: string): number | null {
  // Match current format and legacy format with port
  const match = content.match(/<!-- hotsheet-skill-version: (\d+)(?: port: \d+)? -->/);
  if (!match) return null;
  return parseInt(match[1], 10);
}

export function updateFile(path: string, content: string): boolean {
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf-8');
    const version = parseVersionHeader(existing);
    if (version !== null && version >= SKILL_VERSION) {
      return false;
    }
  }
  writeFileSync(path, content, 'utf-8');
  return true;
}

// --- Shared content ---

function ticketSkillBody(skill: SkillDef, projectRoot: string, dataDir: string = join(projectRoot, '.hotsheet')): string {
  // HS-8936 — `dataDir` defaults to this project's own `.hotsheet`, but a git
  // worktree (follower) passes the OWNER's `.hotsheet` so the skill's worklist
  // path + port/secret point at the shared instance (docs/89 §89.2 Phase C).
  const settings = readFileSettings(dataDir);
  // HS-8390 — settings.port wins; fall back to skillsState.port; final
  // fallback to a placeholder if neither is set (production code always
  // calls initSkills before this runs, so the placeholder only fires in
  // edge-case test paths that skip init).
  const port = settings.port ?? skillsState.port ?? 4174;
  const secret = settings.secret ?? '';
  const secretLine = secret ? `  -H "X-Hotsheet-Secret: ${secret}" \\` : '';
  // HS-8348 — Phase 3 two-form skill body. MCP tool listed first
  // (preferred when the Claude Channel is connected), curl form right
  // below as the universal fallback. The MCP form uses the
  // `hotsheet_create_ticket` tool's FLAT input shape (`{title,
  // category, up_next}`) not the curl form's nested `{title, defaults:
  // {category, up_next}}` — both shapes route to the same REST
  // endpoint, the tool just translates.
  const lines = [
    `Create a new Hot Sheet **${skill.label}** ticket. ${skill.description}.`,
    '',
    '**Parsing the input:**',
    '- If the input starts with "next", "up next", or "do next" (case-insensitive), set `up_next` to `true` and use the remaining text as the title',
    '- Otherwise, use the entire input as the title',
    '',
    '**Create the ticket — MCP tool (preferred when the channel is connected):**',
    `Call the \`hotsheet_create_ticket\` tool with \`{ "title": "<TITLE>", "category": "${skill.category}", "up_next": <true|false> }\`. The tool is schema-validated and routes to the channel server's \`--data-dir\` so there's no chance of cross-project misrouting.`,
    '',
    '**Fallback (curl):**',
    '```bash',
    `curl -s -X POST http://localhost:${port}/api/tickets \\`,
    '  -H "Content-Type: application/json" \\',
  ];
  if (secretLine) lines.push(secretLine);
  lines.push(
    `  -d '{"title": "<TITLE>", "defaults": {"category": "${skill.category}", "up_next": <true|false>}}'`,
    '```',
    '',
    `If the request fails (connection refused or 403), re-read \`.hotsheet/settings.json\` for the current \`port\` and \`secret\` values — you may be connecting to the wrong Hot Sheet instance.`,
    '',
    'Report the created ticket number and title to the user.',
  );
  return lines.join('\n');
}

function mainSkillBody(projectRoot: string, dataDir: string = join(projectRoot, '.hotsheet')): string {
  // HS-8936 — `dataDir` defaults to this project's `.hotsheet`; a worktree
  // follower passes the OWNER's `.hotsheet` so `/hotsheet` reads the shared
  // worklist (the follower has none of its own). The paths stay relative to the
  // worktree root, so they read e.g. `../<repo>/.hotsheet/worklist.md`.
  const worklistRel = relative(projectRoot, join(dataDir, 'worklist.md'));
  const settingsRel = relative(projectRoot, join(dataDir, 'settings.json'));
  // HS-8022 — the HS-7992 `hotsheet_skill_clear_context` toggle was removed.
  // The `/clear` prefix it prepended was loaded as Skill tool output (not
  // typed at the REPL prompt), so the Claude Code CLI never re-parsed it as
  // a slash command and the model couldn't invoke `/clear` itself either —
  // there is no first-class API for a skill or MCP server to clear context
  // when it fires. Users who want a fresh context per /hotsheet should type
  // `/clear` themselves before invoking the skill.
  return [
    `Base directory for this skill: ${join(projectRoot, '.claude', 'skills', 'hotsheet')}`,
    '',
    `Read \`${worklistRel}\` and work through the tickets in priority order.`,
    '',
    'For each ticket:',
    '1. Read the ticket details carefully',
    '2. Implement the work described',
    '3. When complete, mark it done via the Hot Sheet UI',
    '',
    'Work through them in order of priority, where reasonable.',
    '',
    'If the worklist says "Auto-Prioritize", follow those instructions to choose and mark tickets as Up Next before working on them.',
    '',
    `If API calls fail (connection refused or 403), re-read \`${settingsRel}\` for the current \`port\` and \`secret\` values — you may be connecting to the wrong Hot Sheet instance.`,
    '',
    // HS-8348 — Phase 3 main-skill MCP-tools mention. The worklist
    // documents the full per-operation two-form layout; this line tells
    // the agent to prefer the MCP path when it's available.
    '**MCP tools (`hotsheet_*`) are preferred over curl when the channel is connected** — see the worklist for per-operation guidance. The 14-tool surface covers ticket lifecycle (`hotsheet_update_ticket`, `hotsheet_create_ticket`, `hotsheet_get_ticket`, `hotsheet_delete_ticket`, `hotsheet_restore_ticket`, `hotsheet_toggle_up_next`, `hotsheet_duplicate_tickets`), bulk operations (`hotsheet_batch`), notes (`hotsheet_edit_note`, `hotsheet_delete_note`), attachments (`hotsheet_add_attachment`), channel signaling (`hotsheet_signal_done`), feedback sugar (`hotsheet_request_feedback`), and query (`hotsheet_query_tickets`). Curl stays supported as the universal fallback for non-Claude AI agents and human terminal callers.',
  ].join('\n');
}

/**
 * HS-7992 — force-regenerate the main `/hotsheet` skill file for every
 * platform that has been seeded (Claude / Cursor / Copilot / Windsurf).
 * Bypasses the version-check guard in `updateFile` because the regen here
 * was originally triggered by an explicit user action (the General-tab
 * "Clear context on each /hotsheet" toggle), not an upgrade-time recreate.
 *
 * HS-8022 — the toggle was removed (the `/clear` prefix was a no-op when
 * loaded as Skill tool output). The function is kept exported because it
 * is still useful for any future regen-on-explicit-user-action flow, and
 * the SKILL_VERSION bump on this commit means existing files re-author
 * themselves through the normal `updateFile` upgrade path on next boot.
 */
export function regenerateMainSkill(projectRoot: string): void {
  const body = mainSkillBody(projectRoot);
  const targets: { path: string; frontmatter: string[] }[] = [
    {
      path: join(projectRoot, '.claude', 'skills', 'hotsheet', 'SKILL.md'),
      frontmatter: [
        'name: hotsheet',
        'description: Read the Hot Sheet worklist and work through the current priority items',
        'allowed-tools: Read, Grep, Glob, Edit, Write, Bash',
      ],
    },
    {
      path: join(projectRoot, '.cursor', 'rules', 'hotsheet.mdc'),
      frontmatter: [
        'description: Read the Hot Sheet worklist and work through the current priority items',
        'alwaysApply: false',
      ],
    },
    {
      path: join(projectRoot, '.github', 'prompts', 'hotsheet.prompt.md'),
      frontmatter: [
        'description: Read the Hot Sheet worklist and work through the current priority items',
      ],
    },
    {
      path: join(projectRoot, '.windsurf', 'rules', 'hotsheet.md'),
      frontmatter: [
        'trigger: manual',
        'description: Read the Hot Sheet worklist and work through the current priority items',
      ],
    },
  ];
  for (const target of targets) {
    if (!existsSync(target.path)) continue;
    const content = ['---', ...target.frontmatter, '---', versionHeader(), '', body, ''].join('\n');
    writeFileSync(target.path, content, 'utf-8');
  }
}

// --- Claude Code permissions (.claude/settings.json) ---

// Static patterns covering ports 4170-4199 (default 4174 + auto-selected ports up to 4193, with margin)
const HOTSHEET_ALLOW_PATTERNS = [
  'Bash(curl * http://localhost:417*/api/*)',
  'Bash(curl * http://localhost:418*/api/*)',
  'Bash(curl * http://localhost:419*/api/*)',
];

// Matches any old dynamic or current static Hot Sheet curl patterns
const HOTSHEET_CURL_RE = /^Bash\(curl \* http:\/\/localhost:\d+\/api\/\*\)$|^Bash\(curl \* http:\/\/localhost:41[789]\*\/api\/\*\)$/;

function ensureClaudePermissions(cwd: string): boolean {
  // Only configure if port is in the expected range. HS-8390 — explicit
  // undefined check; pre-fix the bare numeric comparison silently
  // succeeded with `NaN < 4170` evaluating false on an uninitialized
  // module-level `let skillPort: number` (the type lied; runtime was
  // undefined). Now we early-return when no port is set.
  const port = skillsState.port;
  if (port === undefined) return false;
  if (port < 4170 || port > 4199) return false;

  const claudeDir = join(cwd, '.claude');
  // HS-8486 (2026-05-22) — pre-fix the `.claude` folder was assumed
  // to exist (the legacy `ensureSkillsForDir` gate required it).
  // Post-fix the gate is "claude is on PATH" which may fire before
  // the user ever creates the folder, so ensure it exists before
  // writing.
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, 'settings.json');

  // HS-8567 — `.loose()` so unrelated user keys round-trip through the
  // overwrite. We only validate the shape we mutate (`permissions.allow`).
  const ClaudeProjectSettingsSchema = z.object({
    permissions: z.object({
      allow: z.array(z.string()).optional(),
    }).loose().optional(),
  }).loose();
  type ClaudeProjectSettings = z.infer<typeof ClaudeProjectSettingsSchema>;
  let settings: ClaudeProjectSettings = {};
  if (existsSync(settingsPath)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const parsed = ClaudeProjectSettingsSchema.safeParse(raw);
      if (parsed.success) settings = parsed.data;
    } catch { /* corrupt file, overwrite */ }
  }

  if (!settings.permissions) settings.permissions = {};
  if (!settings.permissions.allow) settings.permissions.allow = [];

  const allow = settings.permissions.allow;
  if (HOTSHEET_ALLOW_PATTERNS.every(p => allow.includes(p))) return false;

  // Remove any old Hot Sheet curl patterns, add the static ones
  settings.permissions.allow = allow.filter(p => !HOTSHEET_CURL_RE.test(p));
  settings.permissions.allow.push(...HOTSHEET_ALLOW_PATTERNS);

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  return true;
}

// --- Claude Code (.claude/skills/*/SKILL.md) ---

function ensureClaudeSkills(cwd: string, dataDir: string = join(cwd, '.hotsheet')): boolean {
  let updated = false;
  const skillsDir = join(cwd, '.claude', 'skills');

  // Ensure curl permissions for Hot Sheet API calls
  if (ensureClaudePermissions(cwd)) updated = true;

  // Main skill
  const mainDir = join(skillsDir, 'hotsheet');
  mkdirSync(mainDir, { recursive: true });
  const mainContent = [
    '---',
    'name: hotsheet',
    'description: Read the Hot Sheet worklist and work through the current priority items',
    'allowed-tools: Read, Grep, Glob, Edit, Write, Bash',
    '---',
    versionHeader(),
    '',
    mainSkillBody(cwd, dataDir),
    '',
  ].join('\n');
  if (updateFile(join(mainDir, 'SKILL.md'), mainContent)) updated = true;

  // Per-type skills
  for (const skill of buildTicketSkills()) {
    const dir = join(skillsDir, skill.name);
    mkdirSync(dir, { recursive: true });
    const content = [
      '---',
      `name: ${skill.name}`,
      `description: Create a new ${skill.label} ticket in Hot Sheet`,
      'allowed-tools: Bash',
      '---',
      versionHeader(),
      '',
      ticketSkillBody(skill, cwd, dataDir),
      '',
    ].join('\n');
    if (updateFile(join(dir, 'SKILL.md'), content)) updated = true;
  }

  return updated;
}

// --- Cursor (.cursor/rules/*.mdc) ---

function ensureCursorRules(cwd: string): boolean {
  let updated = false;
  const rulesDir = join(cwd, '.cursor', 'rules');
  mkdirSync(rulesDir, { recursive: true });

  // Main rule
  const mainContent = [
    '---',
    'description: Read the Hot Sheet worklist and work through the current priority items',
    'alwaysApply: false',
    '---',
    versionHeader(),
    '',
    mainSkillBody(cwd),
    '',
  ].join('\n');
  if (updateFile(join(rulesDir, 'hotsheet.mdc'), mainContent)) updated = true;

  // Per-type rules
  for (const skill of buildTicketSkills()) {
    const content = [
      '---',
      `description: Create a new ${skill.label} ticket in Hot Sheet`,
      'alwaysApply: false',
      '---',
      versionHeader(),
      '',
      ticketSkillBody(skill, cwd),
      '',
    ].join('\n');
    if (updateFile(join(rulesDir, `${skill.name}.mdc`), content)) updated = true;
  }

  return updated;
}

// --- GitHub Copilot (.github/prompts/*.prompt.md) ---

function ensureCopilotPrompts(cwd: string): boolean {
  let updated = false;
  const promptsDir = join(cwd, '.github', 'prompts');
  mkdirSync(promptsDir, { recursive: true });

  // Main prompt
  const mainContent = [
    '---',
    'description: Read the Hot Sheet worklist and work through the current priority items',
    '---',
    versionHeader(),
    '',
    mainSkillBody(cwd),
    '',
  ].join('\n');
  if (updateFile(join(promptsDir, 'hotsheet.prompt.md'), mainContent)) updated = true;

  // Per-type prompts
  for (const skill of buildTicketSkills()) {
    const content = [
      '---',
      `description: Create a new ${skill.label} ticket in Hot Sheet`,
      '---',
      versionHeader(),
      '',
      ticketSkillBody(skill, cwd),
      '',
    ].join('\n');
    if (updateFile(join(promptsDir, `${skill.name}.prompt.md`), content)) updated = true;
  }

  return updated;
}

// --- Windsurf (.windsurf/rules/*.md) ---

function ensureWindsurfRules(cwd: string): boolean {
  let updated = false;
  const rulesDir = join(cwd, '.windsurf', 'rules');
  mkdirSync(rulesDir, { recursive: true });

  // Main rule
  const mainContent = [
    '---',
    'trigger: manual',
    'description: Read the Hot Sheet worklist and work through the current priority items',
    '---',
    versionHeader(),
    '',
    mainSkillBody(cwd),
    '',
  ].join('\n');
  if (updateFile(join(rulesDir, 'hotsheet.md'), mainContent)) updated = true;

  // Per-type rules
  for (const skill of buildTicketSkills()) {
    const content = [
      '---',
      'trigger: manual',
      `description: Create a new ${skill.label} ticket in Hot Sheet`,
      '---',
      versionHeader(),
      '',
      ticketSkillBody(skill, cwd),
      '',
    ].join('\n');
    if (updateFile(join(rulesDir, `${skill.name}.md`), content)) updated = true;
  }

  return updated;
}

// --- Public API ---

/** Ensure skills for a specific project root directory.
 *
 *  **HS-8486 (2026-05-22)** — detection switched from "AI tool's
 *  project folder exists" to "AI tool's CLI is installed on PATH"
 *  (with the project-folder check kept as a fallback so projects
 *  that already had the folder still get covered). The change
 *  ensures skill files are installed BEFORE the user's first
 *  launch of the AI tool — pre-fix the user had to start the AI
 *  tool at least once for the folder to exist + Hot Sheet to
 *  install skills, which meant the first AI invocation in a new
 *  project ran without the Hot Sheet skill in scope. Copilot keeps
 *  the folder-only gate because there's no reliable executable
 *  name to probe for (it lives inside VS Code as an extension). */
export function ensureSkillsForDir(projectRoot: string, categories?: CategoryDef[], dataDir: string = join(projectRoot, '.hotsheet')): string[] {
  // HS-8910 — generate against THIS project's categories, not whatever the
  // process-global `skillsState.categories` was last set to. The "ensure skills
  // for ALL projects" loops (dashboard.ts / channel.ts / cli.ts) pass each
  // project's own categories so one project's custom category (e.g. a Marketing
  // `m`) can't leak an `hs-m` skill into every OTHER project. Set immediately
  // before the fully SYNCHRONOUS generation below — no await follows, so
  // concurrent callers can't interleave between this assignment and its use in
  // `buildTicketSkills`. Falls back to the global when omitted (bare `ensureSkills`).
  if (categories !== undefined) skillsState.categories = categories;
  const platforms: string[] = [];

  if (isExecutableOnPath('claude') || existsSync(join(projectRoot, '.claude'))) {
    // HS-8936 — `dataDir` defaults to `projectRoot/.hotsheet`; a worktree follower
    // passes the OWNER's `.hotsheet` so `/hotsheet` + the curl skills target the
    // shared instance's worklist + port/secret (docs/89 §89.2 Phase C).
    if (ensureClaudeSkills(projectRoot, dataDir)) platforms.push('Claude Code');
  }
  if (isExecutableOnPath('cursor') || existsSync(join(projectRoot, '.cursor'))) {
    if (ensureCursorRules(projectRoot)) platforms.push('Cursor');
  }
  if (existsSync(join(projectRoot, '.github', 'prompts')) || existsSync(join(projectRoot, '.github', 'copilot-instructions.md'))) {
    if (ensureCopilotPrompts(projectRoot)) platforms.push('GitHub Copilot');
  }
  if (isExecutableOnPath('windsurf') || existsSync(join(projectRoot, '.windsurf'))) {
    if (ensureWindsurfRules(projectRoot)) platforms.push('Windsurf');
  }

  if (platforms.length > 0) {
    skillsState.pendingCreatedFlag = true;
  }
  return platforms;
}

/** Ensure skills for the current working directory (backward compat). */
export function ensureSkills(): string[] {
  return ensureSkillsForDir(process.cwd());
}

export function consumeSkillsCreatedFlag(): boolean {
  const result = skillsState.pendingCreatedFlag;
  skillsState.pendingCreatedFlag = false;
  return result;
}
