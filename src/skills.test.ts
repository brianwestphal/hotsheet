import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  consumeSkillsCreatedFlag,
  ensureSkills,
  initSkills,
  parseVersionHeader,
  setSkillCategories,
  SKILL_VERSION,
  updateFile,
} from './skills.js';
import { DEFAULT_CATEGORIES } from './types.js';

describe('parseVersionHeader', () => {
  it('extracts version from current format', () => {
    expect(parseVersionHeader('<!-- hotsheet-skill-version: 2 -->')).toBe(2);
  });

  it('extracts version from legacy format with port', () => {
    expect(parseVersionHeader('<!-- hotsheet-skill-version: 1 port: 4174 -->')).toBe(1);
  });

  it('returns null for content without a version header', () => {
    expect(parseVersionHeader('no version here')).toBeNull();
  });

  it('returns null for malformed header', () => {
    expect(parseVersionHeader('<!-- hotsheet-skill-version: abc -->')).toBeNull();
  });

  it('works with version header embedded in larger content', () => {
    const content = '---\nname: test\n---\n<!-- hotsheet-skill-version: 3 -->\n\nBody text';
    expect(parseVersionHeader(content)).toBe(3);
  });
});

describe('updateFile', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = join(tmpdir(), `hs-skills-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes new file if not exists', () => {
    const path = join(tempDir, 'new.md');
    const result = updateFile(path, `<!-- hotsheet-skill-version: ${SKILL_VERSION} -->\nContent`);
    expect(result).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain('Content');
  });

  it('overwrites file with lower version', () => {
    const path = join(tempDir, 'old.md');
    writeFileSync(path, '<!-- hotsheet-skill-version: 1 -->\nOld content');
    const result = updateFile(path, `<!-- hotsheet-skill-version: ${SKILL_VERSION} -->\nNew content`);
    expect(result).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain('New content');
  });

  it('skips file with same version', () => {
    const path = join(tempDir, 'same.md');
    writeFileSync(path, `<!-- hotsheet-skill-version: ${SKILL_VERSION} -->\nExisting`);
    const result = updateFile(path, `<!-- hotsheet-skill-version: ${SKILL_VERSION} -->\nReplacement`);
    expect(result).toBe(false);
    expect(readFileSync(path, 'utf-8')).toContain('Existing');
  });

  it('skips file with higher version', () => {
    const path = join(tempDir, 'higher.md');
    writeFileSync(path, `<!-- hotsheet-skill-version: ${SKILL_VERSION + 1} -->\nFuture`);
    const result = updateFile(path, `<!-- hotsheet-skill-version: ${SKILL_VERSION} -->\nCurrent`);
    expect(result).toBe(false);
    expect(readFileSync(path, 'utf-8')).toContain('Future');
  });

  it('overwrites file with legacy port-based format (lower version)', () => {
    const path = join(tempDir, 'legacy.md');
    writeFileSync(path, '<!-- hotsheet-skill-version: 1 port: 4174 -->\nLegacy');
    const result = updateFile(path, `<!-- hotsheet-skill-version: ${SKILL_VERSION} -->\nUpdated`);
    expect(result).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain('Updated');
  });

  it('overwrites file with no version header', () => {
    const path = join(tempDir, 'noheader.md');
    writeFileSync(path, 'No header here');
    const result = updateFile(path, `<!-- hotsheet-skill-version: ${SKILL_VERSION} -->\nNew`);
    expect(result).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain('New');
  });
});

describe('ensureClaudeSkills', () => {
  let tempDir: string;
  let settingsDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `hs-skills-claude-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    settingsDir = join(tempDir, '.hotsheet');
    mkdirSync(settingsDir, { recursive: true });
    // Write a settings.json so ticketSkillBody can read the secret
    writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({ secret: 'test-secret', port: 4174 }));
    // Create .claude directory so ensureSkills detects Claude Code
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    // Init skills with correct port and data dir
    initSkills(4174);
    setSkillCategories(DEFAULT_CATEGORIES);
    // Override process.cwd() for skill creation
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates main SKILL.md for Claude Code', () => {
    ensureSkills();
    const mainSkill = join(tempDir, '.claude', 'skills', 'hotsheet', 'SKILL.md');
    expect(existsSync(mainSkill)).toBe(true);
    const content = readFileSync(mainSkill, 'utf-8');
    expect(content).toContain('name: hotsheet');
    expect(content).toContain('worklist.md');
    expect(content).toContain(`hotsheet-skill-version: ${SKILL_VERSION}`);
    expect(content).toContain('allowed-tools: Read, Grep, Glob, Edit, Write, Bash');
  });

  it('creates per-category ticket skills', () => {
    ensureSkills();
    for (const cat of DEFAULT_CATEGORIES) {
      const skillName = `hs-${cat.id.replace(/_/g, '-')}`;
      const skillPath = join(tempDir, '.claude', 'skills', skillName, 'SKILL.md');
      expect(existsSync(skillPath)).toBe(true);
      const content = readFileSync(skillPath, 'utf-8');
      expect(content).toContain(`name: ${skillName}`);
      expect(content).toContain(cat.label.toLowerCase());
      expect(content).toContain('allowed-tools: Bash');
      expect(content).toContain('curl');
      expect(content).toContain(`"category": "${cat.id}"`);
    }
  });

  it('includes secret header in ticket skill when secret is set', () => {
    ensureSkills();
    const skillPath = join(tempDir, '.claude', 'skills', 'hs-bug', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf-8');
    expect(content).toContain('X-Hotsheet-Secret: test-secret');
  });

  it('omits secret header when no secret in settings', () => {
    writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({}));
    ensureSkills();
    const skillPath = join(tempDir, '.claude', 'skills', 'hs-bug', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf-8');
    expect(content).not.toContain('X-Hotsheet-Secret');
  });

  it('does not overwrite skills when version is current', () => {
    ensureSkills();
    const skillPath = join(tempDir, '.claude', 'skills', 'hotsheet', 'SKILL.md');
    const firstContent = readFileSync(skillPath, 'utf-8');
    // Call again — should not overwrite
    const platforms = ensureSkills();
    expect(platforms).toHaveLength(0);
    const secondContent = readFileSync(skillPath, 'utf-8');
    expect(secondContent).toBe(firstContent);
  });

  it('returns platform name when skills are created', () => {
    const platforms = ensureSkills();
    expect(platforms).toContain('Claude Code');
  });

  it('returns empty array when no platform directories exist', () => {
    rmSync(join(tempDir, '.claude'), { recursive: true, force: true });
    const platforms = ensureSkills();
    expect(platforms).toHaveLength(0);
  });
});

describe('ensureClaudePermissions', () => {
  let tempDir: string;
  let settingsDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `hs-skills-perms-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    settingsDir = join(tempDir, '.hotsheet');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({ secret: 'abc', port: 4174 }));
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    initSkills(4174);
    setSkillCategories(DEFAULT_CATEGORIES);
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates .claude/settings.json with curl permission patterns', () => {
    ensureSkills();
    const settingsPath = join(tempDir, '.claude', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { permissions: { allow: string[] } };
    expect(settings.permissions.allow).toContain('Bash(curl * http://localhost:417*/api/*)');
    expect(settings.permissions.allow).toContain('Bash(curl * http://localhost:418*/api/*)');
  });

  it('preserves existing permission entries', () => {
    const settingsPath = join(tempDir, '.claude', 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      permissions: { allow: ['Bash(git *)'] },
    }));
    ensureSkills();
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { permissions: { allow: string[] } };
    expect(settings.permissions.allow).toContain('Bash(git *)');
    expect(settings.permissions.allow).toContain('Bash(curl * http://localhost:417*/api/*)');
  });

  it('removes old dynamic curl patterns when adding new static ones', () => {
    const settingsPath = join(tempDir, '.claude', 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      permissions: { allow: ['Bash(curl * http://localhost:4174/api/*)'] },
    }));
    ensureSkills();
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { permissions: { allow: string[] } };
    // Old dynamic pattern removed
    expect(settings.permissions.allow).not.toContain('Bash(curl * http://localhost:4174/api/*)');
    // New static patterns added
    expect(settings.permissions.allow).toContain('Bash(curl * http://localhost:417*/api/*)');
  });

  it('skips permission update when patterns already present', () => {
    const settingsPath = join(tempDir, '.claude', 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      permissions: {
        allow: [
          'Bash(curl * http://localhost:417*/api/*)',
          'Bash(curl * http://localhost:418*/api/*)',
          'Bash(curl * http://localhost:419*/api/*)',
        ],
      },
    }));
    // Skills themselves don't exist yet, so ensureSkills will still create them,
    // but permissions should not be re-written
    ensureSkills();
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { permissions: { allow: string[] } };
    // Verify no duplicate patterns
    const curlPatterns = settings.permissions.allow.filter((p: string) => p.includes('curl'));
    expect(curlPatterns).toHaveLength(3);
  });

  it('does not add permissions when port is out of range', () => {
    initSkills(5000);
    ensureSkills();
    const settingsPath = join(tempDir, '.claude', 'settings.json');
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { permissions?: { allow?: string[] } };
      // Should not have curl patterns since port is out of 4170-4189 range
      const hasPatterns = settings.permissions?.allow?.some((p: string) => p.includes('curl'));
      expect(hasPatterns).toBeFalsy();
    }
  });
});

describe('mainSkillBody content', () => {
  let tempDir: string;
  let settingsDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `hs-skills-main-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    settingsDir = join(tempDir, '.hotsheet');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({}));
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    initSkills(4174);
    setSkillCategories(DEFAULT_CATEGORIES);
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('references worklist.md and settings.json paths', () => {
    ensureSkills();
    const mainSkill = join(tempDir, '.claude', 'skills', 'hotsheet', 'SKILL.md');
    const content = readFileSync(mainSkill, 'utf-8');
    expect(content).toContain('worklist.md');
    expect(content).toContain('settings.json');
  });

  it('includes priority order and auto-prioritize instructions', () => {
    ensureSkills();
    const mainSkill = join(tempDir, '.claude', 'skills', 'hotsheet', 'SKILL.md');
    const content = readFileSync(mainSkill, 'utf-8');
    expect(content).toContain('priority order');
    expect(content).toContain('Auto-Prioritize');
  });

  it('includes API failure recovery instructions', () => {
    ensureSkills();
    const mainSkill = join(tempDir, '.claude', 'skills', 'hotsheet', 'SKILL.md');
    const content = readFileSync(mainSkill, 'utf-8');
    expect(content).toContain('connection refused or 403');
    expect(content).toContain('re-read');
  });
});

describe('ticket creation skill content', () => {
  let tempDir: string;
  let settingsDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `hs-skills-ticket-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    settingsDir = join(tempDir, '.hotsheet');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({ secret: 'mysecret', port: 4174 }));
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    initSkills(4174);
    setSkillCategories(DEFAULT_CATEGORIES);
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('includes curl POST command with correct port', () => {
    ensureSkills();
    const skillPath = join(tempDir, '.claude', 'skills', 'hs-bug', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf-8');
    expect(content).toContain('curl -s -X POST http://localhost:4174/api/tickets');
  });

  it('includes up_next parsing instructions', () => {
    ensureSkills();
    const skillPath = join(tempDir, '.claude', 'skills', 'hs-feature', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf-8');
    expect(content).toContain('up_next');
    expect(content).toContain('"next"');
    expect(content).toContain('"up next"');
  });

  it('includes category-specific description', () => {
    ensureSkills();
    const skillPath = join(tempDir, '.claude', 'skills', 'hs-bug', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf-8');
    expect(content).toContain('bug');
    expect(content).toContain('Bugs that should be fixed');
  });

  it('instructs to report ticket number after creation', () => {
    ensureSkills();
    const skillPath = join(tempDir, '.claude', 'skills', 'hs-task', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf-8');
    expect(content).toContain('Report the created ticket number');
  });
});

describe('consumeSkillsCreatedFlag', () => {
  let tempDir: string;
  let settingsDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `hs-skills-flag-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    settingsDir = join(tempDir, '.hotsheet');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({}));
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    initSkills(4174);
    setSkillCategories(DEFAULT_CATEGORIES);
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns true after skills are created, then false on subsequent call', () => {
    // Reset flag by consuming it
    consumeSkillsCreatedFlag();

    ensureSkills();
    expect(consumeSkillsCreatedFlag()).toBe(true);
    expect(consumeSkillsCreatedFlag()).toBe(false);
  });

  it('returns false when no skills were created', () => {
    consumeSkillsCreatedFlag();
    // Remove platform directories
    rmSync(join(tempDir, '.claude'), { recursive: true, force: true });
    ensureSkills();
    expect(consumeSkillsCreatedFlag()).toBe(false);
  });
});

describe('setSkillCategories', () => {
  let tempDir: string;
  let settingsDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `hs-skills-cat-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    settingsDir = join(tempDir, '.hotsheet');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({}));
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    initSkills(4174);
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses custom categories for skill generation', () => {
    const customCategories = [
      { id: 'epic', label: 'Epic', shortLabel: 'EPC', color: '#8b5cf6', shortcutKey: 'e', description: 'Large initiatives' },
      { id: 'story', label: 'Story', shortLabel: 'STY', color: '#3b82f6', shortcutKey: 's', description: 'User stories' },
    ];
    setSkillCategories(customCategories);
    ensureSkills();

    // Custom category skill should exist
    const epicSkill = join(tempDir, '.claude', 'skills', 'hs-epic', 'SKILL.md');
    expect(existsSync(epicSkill)).toBe(true);
    const content = readFileSync(epicSkill, 'utf-8');
    expect(content).toContain('epic');
    expect(content).toContain('Large initiatives');

    // Default category skill should not exist
    const bugSkill = join(tempDir, '.claude', 'skills', 'hs-bug', 'SKILL.md');
    expect(existsSync(bugSkill)).toBe(false);

    // Restore defaults for other tests
    setSkillCategories(DEFAULT_CATEGORIES);
  });
});

describe('multi-platform skill creation', () => {
  let tempDir: string;
  let settingsDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `hs-skills-multi-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    settingsDir = join(tempDir, '.hotsheet');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({}));
    initSkills(4174);
    setSkillCategories(DEFAULT_CATEGORIES);
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates Cursor rules when .cursor directory exists', () => {
    mkdirSync(join(tempDir, '.cursor'), { recursive: true });
    const platforms = ensureSkills();
    expect(platforms).toContain('Cursor');
    const mainRule = join(tempDir, '.cursor', 'rules', 'hotsheet.mdc');
    expect(existsSync(mainRule)).toBe(true);
    const content = readFileSync(mainRule, 'utf-8');
    expect(content).toContain('alwaysApply: false');
    expect(content).toContain('worklist.md');
  });

  it('creates Copilot prompts when .github/prompts exists', () => {
    mkdirSync(join(tempDir, '.github', 'prompts'), { recursive: true });
    const platforms = ensureSkills();
    expect(platforms).toContain('GitHub Copilot');
    const mainPrompt = join(tempDir, '.github', 'prompts', 'hotsheet.prompt.md');
    expect(existsSync(mainPrompt)).toBe(true);
  });

  it('creates Copilot prompts when copilot-instructions.md exists', () => {
    mkdirSync(join(tempDir, '.github'), { recursive: true });
    writeFileSync(join(tempDir, '.github', 'copilot-instructions.md'), '');
    const platforms = ensureSkills();
    expect(platforms).toContain('GitHub Copilot');
  });

  it('creates Windsurf rules when .windsurf directory exists', () => {
    mkdirSync(join(tempDir, '.windsurf'), { recursive: true });
    const platforms = ensureSkills();
    expect(platforms).toContain('Windsurf');
    const mainRule = join(tempDir, '.windsurf', 'rules', 'hotsheet.md');
    expect(existsSync(mainRule)).toBe(true);
    const content = readFileSync(mainRule, 'utf-8');
    expect(content).toContain('trigger: manual');
  });

  it('creates skills for multiple platforms simultaneously', () => {
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    mkdirSync(join(tempDir, '.cursor'), { recursive: true });
    mkdirSync(join(tempDir, '.windsurf'), { recursive: true });
    const platforms = ensureSkills();
    expect(platforms).toContain('Claude Code');
    expect(platforms).toContain('Cursor');
    expect(platforms).toContain('Windsurf');
    expect(platforms).toHaveLength(3);
  });
});
