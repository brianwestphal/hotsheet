import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';

import { readFileSettings } from './file-settings.js';
import type { CategoryDef } from './types.js';
import { DEFAULT_CATEGORIES } from './types.js';

export const SKILL_VERSION = 5;

let skillPort: number;
let skillDataDir: string;
let skillCategories: CategoryDef[] = DEFAULT_CATEGORIES;

export function initSkills(port: number, dataDir: string) {
  skillPort = port;
  skillDataDir = dataDir;
}

export function setSkillCategories(categories: CategoryDef[]) {
  skillCategories = categories;
}

interface SkillDef {
  name: string;
  category: string;
  label: string;
  description: string;
}

function buildTicketSkills(): SkillDef[] {
  return skillCategories.map(cat => ({
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

function ticketSkillBody(skill: SkillDef): string {
  const settings = readFileSettings(skillDataDir);
  const secret = settings.secret || '';
  const secretLine = secret ? `  -H "X-Hotsheet-Secret: ${secret}" \\` : '';
  const lines = [
    `Create a new Hot Sheet **${skill.label}** ticket. ${skill.description}.`,
    '',
    '**Parsing the input:**',
    '- If the input starts with "next", "up next", or "do next" (case-insensitive), set `up_next` to `true` and use the remaining text as the title',
    '- Otherwise, use the entire input as the title',
    '',
    '**Create the ticket** by running:',
    '```bash',
    `curl -s -X POST http://localhost:${skillPort}/api/tickets \\`,
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

function mainSkillBody(): string {
  const worklistRel = relative(process.cwd(), join(skillDataDir, 'worklist.md'));
  const settingsRel = relative(process.cwd(), join(skillDataDir, 'settings.json'));
  return [
    `Base directory for this skill: ${join(process.cwd(), '.claude', 'skills', 'hotsheet')}`,
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
  ].join('\n');
}

// --- Claude Code permissions (.claude/settings.json) ---

// Static patterns covering ports 4170-4189 (default 4174 + nearby auto-selected ports)
const HOTSHEET_ALLOW_PATTERNS = [
  'Bash(curl * http://localhost:417*/api/*)',
  'Bash(curl * http://localhost:418*/api/*)',
];

// Matches any old dynamic or current static Hot Sheet curl patterns
const HOTSHEET_CURL_RE = /^Bash\(curl \* http:\/\/localhost:\d+\/api\/\*\)$|^Bash\(curl \* http:\/\/localhost:41[78]\*\/api\/\*\)$/;

function ensureClaudePermissions(cwd: string): boolean {
  // Only configure if port is in the expected range
  if (skillPort < 4170 || skillPort > 4189) return false;

  const settingsPath = join(cwd, '.claude', 'settings.json');

  let settings: { permissions?: { allow?: string[] }; [key: string]: unknown } = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
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

function ensureClaudeSkills(cwd: string): boolean {
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
    mainSkillBody(),
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
      ticketSkillBody(skill),
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
    mainSkillBody(),
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
      ticketSkillBody(skill),
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
    mainSkillBody(),
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
      ticketSkillBody(skill),
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
    mainSkillBody(),
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
      ticketSkillBody(skill),
      '',
    ].join('\n');
    if (updateFile(join(rulesDir, `${skill.name}.md`), content)) updated = true;
  }

  return updated;
}

// --- Public API ---

// Tracks whether skills were created/updated in this server session.
// Consumed once by the UI endpoint so the banner shows even though
// cli.ts already called ensureSkills() before the page loaded.
let pendingCreatedFlag = false;

export function ensureSkills(): string[] {
  const cwd = process.cwd();
  const platforms: string[] = [];

  // Claude Code: detect .claude/ directory
  if (existsSync(join(cwd, '.claude'))) {
    if (ensureClaudeSkills(cwd)) platforms.push('Claude Code');
  }

  // Cursor: detect .cursor/ directory
  if (existsSync(join(cwd, '.cursor'))) {
    if (ensureCursorRules(cwd)) platforms.push('Cursor');
  }

  // GitHub Copilot: detect existing prompts dir or copilot instructions file
  if (existsSync(join(cwd, '.github', 'prompts')) || existsSync(join(cwd, '.github', 'copilot-instructions.md'))) {
    if (ensureCopilotPrompts(cwd)) platforms.push('GitHub Copilot');
  }

  // Windsurf: detect .windsurf/ directory
  if (existsSync(join(cwd, '.windsurf'))) {
    if (ensureWindsurfRules(cwd)) platforms.push('Windsurf');
  }

  if (platforms.length > 0) {
    pendingCreatedFlag = true;
  }

  return platforms;
}

export function consumeSkillsCreatedFlag(): boolean {
  const result = pendingCreatedFlag;
  pendingCreatedFlag = false;
  return result;
}
