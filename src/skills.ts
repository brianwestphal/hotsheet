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

function versionHeader(): string {
  return `<!-- hotsheet-skill-version: ${SKILL_VERSION} port: ${skillPort} -->`;
}

function parseVersionHeader(content: string): { version: number; port: number } | null {
  const match = content.match(/<!-- hotsheet-skill-version: (\d+) port: (\d+) -->/);
  if (!match) return null;
  return { version: parseInt(match[1], 10), port: parseInt(match[2], 10) };
}

function generateTicketSkillContent(skill: SkillDef): string {
  const desc = CATEGORY_DESCRIPTIONS[skill.category];
  return [
    '---',
    `name: ${skill.name}`,
    `description: Create a new ${skill.label} ticket in Hot Sheet`,
    'allowed-tools: Bash',
    '---',
    versionHeader(),
    '',
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
    '',
  ].join('\n');
}

function generateMainSkillContent(): string {
  const worklistRel = relative(process.cwd(), join(skillDataDir, 'worklist.md'));
  return [
    '---',
    'name: hotsheet',
    'description: Read the Hot Sheet worklist and work through the current priority items',
    'allowed-tools: Read, Grep, Glob, Edit, Write, Bash',
    '---',
    versionHeader(),
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
  ].join('\n');
}

function updateSkillFile(path: string, content: string): boolean {
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

export function ensureSkills(): boolean {
  const cwd = process.cwd();
  const claudeDir = join(cwd, '.claude');
  if (!existsSync(claudeDir)) return false;

  let updated = false;

  // Update main hotsheet skill
  const mainSkillDir = join(claudeDir, 'skills', 'hotsheet');
  mkdirSync(mainSkillDir, { recursive: true });
  if (updateSkillFile(join(mainSkillDir, 'SKILL.md'), generateMainSkillContent())) {
    updated = true;
  }

  // Update per-type ticket creation skills
  for (const skill of TICKET_SKILLS) {
    const skillDir = join(claudeDir, 'skills', skill.name);
    mkdirSync(skillDir, { recursive: true });
    if (updateSkillFile(join(skillDir, 'SKILL.md'), generateTicketSkillContent(skill))) {
      updated = true;
    }
  }

  return updated;
}
