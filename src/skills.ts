import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';

import type { TicketCategory } from './types.js';
import { CATEGORY_DESCRIPTIONS } from './types.js';

const SKILL_VERSION = 1;

let skillPort: number;
let skillDataDir: string;

export function initSkills(port: number, dataDir: string) {
  skillPort = port;
  skillDataDir = dataDir;
}

interface SkillDef {
  name: string;
  category: TicketCategory;
  label: string;
}

const TICKET_SKILLS: SkillDef[] = [
  { name: 'hs-bug', category: 'bug', label: 'bug' },
  { name: 'hs-feature', category: 'feature', label: 'feature' },
  { name: 'hs-task', category: 'task', label: 'task' },
  { name: 'hs-issue', category: 'issue', label: 'issue' },
  { name: 'hs-investigation', category: 'investigation', label: 'investigation' },
  { name: 'hs-req-change', category: 'requirement_change', label: 'requirement change' },
];

// --- Version tracking ---

function versionHeader(): string {
  return `<!-- hotsheet-skill-version: ${SKILL_VERSION} port: ${skillPort} -->`;
}

function parseVersionHeader(content: string): { version: number; port: number } | null {
  const match = content.match(/<!-- hotsheet-skill-version: (\d+) port: (\d+) -->/);
  if (!match) return null;
  return { version: parseInt(match[1], 10), port: parseInt(match[2], 10) };
}

function updateFile(path: string, content: string): boolean {
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf-8');
    const header = parseVersionHeader(existing);
    if (header && header.version >= SKILL_VERSION && header.port === skillPort) {
      return false;
    }
  }
  writeFileSync(path, content, 'utf-8');
  return true;
}

// --- Shared content ---

function ticketSkillBody(skill: SkillDef): string {
  const desc = CATEGORY_DESCRIPTIONS[skill.category];
  return [
    `Create a new Hot Sheet **${skill.label}** ticket. ${desc}.`,
    '',
    '**Parsing the input:**',
    '- If the input starts with "next", "up next", or "do next" (case-insensitive), set `up_next` to `true` and use the remaining text as the title',
    '- Otherwise, use the entire input as the title',
    '',
    '**Create the ticket** by running:',
    '```bash',
    `curl -s -X POST http://localhost:${skillPort}/api/tickets \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '{"title": "<TITLE>", "defaults": {"category": "${skill.category}", "up_next": <true|false>}}'`,
    '```',
    '',
    'Report the created ticket number and title to the user.',
  ].join('\n');
}

function mainSkillBody(): string {
  const worklistRel = relative(process.cwd(), join(skillDataDir, 'worklist.md'));
  return [
    `Read \`${worklistRel}\` and work through the tickets in priority order.`,
    '',
    'For each ticket:',
    '1. Read the ticket details carefully',
    '2. Implement the work described',
    '3. When complete, mark it done via the Hot Sheet UI',
    '',
    'Work through them in order of priority, where reasonable.',
  ].join('\n');
}

// --- Claude Code (.claude/skills/*/SKILL.md) ---

function ensureClaudeSkills(cwd: string): boolean {
  let updated = false;
  const skillsDir = join(cwd, '.claude', 'skills');

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
  for (const skill of TICKET_SKILLS) {
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
  for (const skill of TICKET_SKILLS) {
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
  for (const skill of TICKET_SKILLS) {
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
  for (const skill of TICKET_SKILLS) {
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

  return platforms;
}
