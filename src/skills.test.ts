import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetSkillsStateForTesting,
  consumeSkillsCreatedFlag,
  ensureSkills,
  ensureSkillsForDir,
  initSkills,
  parseVersionHeader,
  regenerateMainSkill,
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
    // HS-9044 — the main skill is the single integrator for worker branches.
    expect(content).toContain('single integrator');
    expect(content).toContain('git fetch');
    expect(content).toMatch(/NEVER `git push`/);
    // HS-9045 — the owner clears the merge-pending flag when it integrates.
    expect(content).toContain('pending_integration');
    // HS-9048 — the owner integrates via the helper endpoints.
    expect(content).toContain('/api/workers/integrate');
  });

  it('HS-8863 — creates the distributed worker skill (Claude-only)', () => {
    ensureSkills();
    const workerSkill = join(tempDir, '.claude', 'skills', 'hotsheet-worker', 'SKILL.md');
    expect(existsSync(workerSkill)).toBe(true);
    const content = readFileSync(workerSkill, 'utf-8');
    expect(content).toContain('name: hotsheet-worker');
    expect(content).toContain(`hotsheet-skill-version: ${SKILL_VERSION}`);
    // The loop body references the claim/lease MCP tools.
    expect(content).toContain('hotsheet_claim_next');
    expect(content).toContain('hotsheet_renew_lease');
    expect(content).toContain('hotsheet_release');
    expect(content).toContain('hotsheet_signal_done');
    // HS-9044 — workers commit + rebase onto the target to stay current and hand
    // off to the owner-integrator; they never write the target, never push.
    expect(content).toContain('Staying in sync');
    expect(content).toContain('git rebase');
    expect(content).toMatch(/NEVER `git push`/);
    expect(content).toContain('single integrator');
    // HS-9045 — the worker sets the merge-pending flag on completion.
    expect(content).toContain('pending_integration');
  });

  it('HS-8936 — ensureSkillsForDir dataDir override points the worktree skill at the OWNER worklist', () => {
    const ownerData = join(tempDir, 'owner', '.hotsheet');
    mkdirSync(ownerData, { recursive: true });
    const wtRoot = join(tempDir, 'wt');
    mkdirSync(join(wtRoot, '.claude'), { recursive: true }); // force the Claude path regardless of PATH

    ensureSkillsForDir(wtRoot, undefined, ownerData);

    const mainSkill = join(wtRoot, '.claude', 'skills', 'hotsheet', 'SKILL.md');
    expect(existsSync(mainSkill)).toBe(true);
    const content = readFileSync(mainSkill, 'utf-8');
    // The worklist reference is relative to the worktree root but resolves to the
    // OWNER's .hotsheet (the follower has no worklist of its own).
    expect(content).toContain(relative(wtRoot, join(ownerData, 'worklist.md')));
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
    // HS-8486 — `ensureSkillsForDir` also triggers on PATH-installed AI tools
    // (e.g. dev machines with `claude` on PATH). HS-8785 — and on
    // `extraSearchDirs()` (`~/.local/bin`, `~/.claude/local`), so also point
    // `$HOME` at the empty tempDir (`os.homedir()` honors it on POSIX). Override
    // both so this exercises the pure no-platform branch.
    const savedPath = process.env.PATH;
    const savedHome = process.env.HOME;
    process.env.PATH = '';
    process.env.HOME = tempDir;
    try {
      const platforms = ensureSkills();
      expect(platforms).toHaveLength(0);
    } finally {
      process.env.PATH = savedPath;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });

  // -------------------------------------------------------------------------
  // HS-8022 — `/clear` prefix permanently removed
  // -------------------------------------------------------------------------
  // The HS-7992 `hotsheet_skill_clear_context` toggle was a dead switch:
  // skill bodies are loaded as Skill tool output, not typed at the REPL
  // prompt, so the Claude Code CLI never re-parsed `/clear` as a slash
  // command and the model couldn't invoke it itself either. The toggle +
  // prefix were removed in HS-8022. These regressions guard against a
  // future contributor re-adding it without re-checking the underlying
  // mechanism.

  it('never includes a `/clear` line in the main skill body (HS-8022)', () => {
    ensureSkills();
    const skillPath = join(tempDir, '.claude', 'skills', 'hotsheet', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf-8');
    expect(content).not.toMatch(/^\/clear$/m);
  });

  it('ignores a stale `hotsheet_skill_clear_context: true` setting in settings.json (HS-8022)', () => {
    // Some users may have flipped the toggle on in an older build. Confirm
    // that the setting being present + true does NOT resurrect the prefix.
    writeFileSync(
      join(settingsDir, 'settings.json'),
      JSON.stringify({ secret: 'test-secret', port: 4174, hotsheet_skill_clear_context: true }),
    );
    ensureSkills();
    const skillPath = join(tempDir, '.claude', 'skills', 'hotsheet', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf-8');
    expect(content).not.toMatch(/^\/clear$/m);
  });

  it('regenerateMainSkill never writes a `/clear` prefix even when the stale setting is true (HS-8022)', () => {
    ensureSkills();
    writeFileSync(
      join(settingsDir, 'settings.json'),
      JSON.stringify({ secret: 'test-secret', port: 4174, hotsheet_skill_clear_context: true }),
    );
    regenerateMainSkill(tempDir);
    const skillPath = join(tempDir, '.claude', 'skills', 'hotsheet', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf-8');
    expect(content).not.toMatch(/^\/clear$/m);
  });
});

// HS-8706 — the installed (Tauri) beta app hung forever on the "Starting Hot
// Sheet…" splash. ROOT CAUSE: the primary-startup path in cli.ts installed AI
// tool skills via `ensureSkills()`, which keyed off `process.cwd()`. A GUI
// launch spawns the sidecar with `cwd = /`, so with `claude` on PATH the writer
// tried `mkdirSync('/.claude')` → ENOENT → the unhandled throw FATAL-exited the
// server moments after it started listening, wedging the splash. A
// direct-from-terminal launch only worked by accident (its cwd WAS the project
// root). The fix points the primary path at `ensureSkillsForDir(projectRoot)`
// derived from `dataDir`. These tests pin that `ensureSkillsForDir` is
// cwd-independent (the property the fix relies on) and that the wiring uses it.
describe('skill install is cwd-independent (HS-8706 launch hang)', () => {
  let projectDir: string;
  let elsewhereCwd: string;

  beforeEach(() => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    projectDir = join(tmpdir(), `hs-skills-proj-${stamp}`);
    elsewhereCwd = join(tmpdir(), `hs-skills-cwd-${stamp}`);
    mkdirSync(join(projectDir, '.hotsheet'), { recursive: true });
    mkdirSync(join(projectDir, '.claude'), { recursive: true });
    mkdirSync(elsewhereCwd, { recursive: true });
    writeFileSync(join(projectDir, '.hotsheet', 'settings.json'), JSON.stringify({ secret: 'test-secret', port: 4174 }));
    initSkills(4174);
    setSkillCategories(DEFAULT_CATEGORIES);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(elsewhereCwd, { recursive: true, force: true });
  });

  it('writes skills to the passed project root, NOT to process.cwd()', () => {
    // Simulate the GUI launch: cwd is some unrelated directory, the project
    // being served is elsewhere. Pre-fix `ensureSkills()` wrote relative to cwd.
    vi.spyOn(process, 'cwd').mockReturnValue(elsewhereCwd);

    const platforms = ensureSkillsForDir(projectDir);

    expect(platforms).toContain('Claude Code');
    expect(existsSync(join(projectDir, '.claude', 'skills', 'hotsheet', 'SKILL.md'))).toBe(true);
    // The cwd directory must be left completely untouched — no stray `.claude`.
    expect(existsSync(join(elsewhereCwd, '.claude'))).toBe(false);
  });

  it('does not throw when process.cwd() is a non-writable / nonexistent path', () => {
    // This is the exact failure mode: GUI cwd was `/` and mkdir('/.claude')
    // threw ENOENT. Proving `ensureSkillsForDir` never consults cwd means a
    // hostile cwd can no longer crash the writer.
    vi.spyOn(process, 'cwd').mockReturnValue('/nonexistent-cwd-hs8706/deep/path');

    expect(() => ensureSkillsForDir(projectDir)).not.toThrow();
    expect(existsSync(join(projectDir, '.claude', 'skills', 'hotsheet', 'SKILL.md'))).toBe(true);
  });
});

// HS-8910 — skill generation must use the project's OWN categories, not the
// process-global `skillsState.categories` (which holds whatever project last
// called `setSkillCategories`). Pre-fix, the "ensure ALL projects" loops leaked
// one project's custom category (e.g. a Marketing `m`) into every other project,
// so a project with only the defaults kept getting a spurious `hs-m` skill.
describe('ensureSkillsForDir uses the passed categories, not the stale global (HS-8910)', () => {
  let projectDir: string;
  const MARKETING = { id: 'm', label: 'Marketing', shortLabel: 'MKT', color: '#8b5cf6', shortcutKey: 'm', description: 'Marketing tasks' };

  beforeEach(() => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    projectDir = join(tmpdir(), `hs-skills-8910-${stamp}`);
    mkdirSync(join(projectDir, '.hotsheet'), { recursive: true });
    mkdirSync(join(projectDir, '.claude'), { recursive: true });
    writeFileSync(join(projectDir, '.hotsheet', 'settings.json'), JSON.stringify({ secret: 'test-secret', port: 4174 }));
    initSkills(4174);
    _resetSkillsStateForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetSkillsStateForTesting();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('does NOT write hs-m when the global has Marketing but the passed categories do not', () => {
    // Simulate another project (with a Marketing category) having set the global.
    setSkillCategories([...DEFAULT_CATEGORIES, MARKETING]);
    // This project owns only the defaults — pass them explicitly.
    ensureSkillsForDir(projectDir, DEFAULT_CATEGORIES);

    expect(existsSync(join(projectDir, '.claude', 'skills', 'hs-m', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(projectDir, '.claude', 'skills', 'hs-bug', 'SKILL.md'))).toBe(true);
  });

  it('DOES write hs-m when the passed categories include Marketing', () => {
    ensureSkillsForDir(projectDir, [...DEFAULT_CATEGORIES, MARKETING]);
    expect(existsSync(join(projectDir, '.claude', 'skills', 'hs-m', 'SKILL.md'))).toBe(true);
  });

  it('falls back to the global when no categories are passed (back-compat)', () => {
    setSkillCategories([...DEFAULT_CATEGORIES, MARKETING]);
    ensureSkillsForDir(projectDir);
    expect(existsSync(join(projectDir, '.claude', 'skills', 'hs-m', 'SKILL.md'))).toBe(true);
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
    // HS-8486 — override PATH so executable detection doesn't trigger the
    // PATH-based Claude install branch. HS-8785 — also point `$HOME` at the empty
    // tempDir so `extraSearchDirs()` (`~/.local/bin`, `~/.claude/local`) can't
    // leak a dev machine's real `claude` install.
    const savedPath = process.env.PATH;
    const savedHome = process.env.HOME;
    process.env.PATH = '';
    process.env.HOME = tempDir;
    try {
      ensureSkills();
      expect(consumeSkillsCreatedFlag()).toBe(false);
    } finally {
      process.env.PATH = savedPath;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
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

describe('_resetSkillsStateForTesting (HS-8390)', () => {
  let tempDir: string;
  let settingsDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `hs-skills-reset-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    settingsDir = join(tempDir, '.hotsheet');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({}));
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
    // Restore default state so other test files aren't affected by our resets.
    initSkills(4174);
    setSkillCategories(DEFAULT_CATEGORIES);
  });

  it('clears port back to undefined so ensureClaudePermissions early-returns until re-init', () => {
    // After explicit reset, port is undefined → ensureClaudePermissions
    // bails before touching .claude/settings.json. Pre-HS-8390 the bare
    // `skillPort < 4170` comparison would silently see `NaN < 4170` (false)
    // and fall through to writing the file even with no port set.
    initSkills(4174);
    setSkillCategories(DEFAULT_CATEGORIES);
    _resetSkillsStateForTesting();
    ensureSkills();
    const claudeSettings = join(tempDir, '.claude', 'settings.json');
    expect(existsSync(claudeSettings)).toBe(false);
  });

  it('clears categories back to DEFAULT_CATEGORIES', () => {
    setSkillCategories([
      { id: 'epic', label: 'Epic', shortLabel: 'EPC', color: '#8b5cf6', shortcutKey: 'e', description: 'Large initiatives' },
    ]);
    _resetSkillsStateForTesting();
    initSkills(4174);
    ensureSkills();
    // After reset, the default `hs-bug` skill should exist (from
    // DEFAULT_CATEGORIES) and the custom `hs-epic` should not.
    expect(existsSync(join(tempDir, '.claude', 'skills', 'hs-bug', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(tempDir, '.claude', 'skills', 'hs-epic', 'SKILL.md'))).toBe(false);
  });

  it('clears pendingCreatedFlag back to false', () => {
    initSkills(4174);
    setSkillCategories(DEFAULT_CATEGORIES);
    ensureSkills(); // sets pendingCreatedFlag = true
    _resetSkillsStateForTesting();
    expect(consumeSkillsCreatedFlag()).toBe(false);
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

/**
 * HS-8486 (2026-05-22) — `ensureSkillsForDir` should install AI-tool
 * skill files when the corresponding CLI is on `PATH`, even if the
 * project doesn't yet have the tool's dotfolder. The pre-fix
 * "dotfolder must exist" gate meant the user's first launch of the
 * AI tool ran without the Hot Sheet skill in scope; post-fix the
 * skill is already there.
 */
describe('ensureSkillsForDir — PATH-based detection (HS-8486)', () => {
  let tempDir: string;
  let fakeBinDir: string;
  let savedPath: string | undefined;
  let savedHome: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `hs-skills-path-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fakeBinDir = join(tempDir, 'fake-bin');
    mkdirSync(join(tempDir, '.hotsheet'), { recursive: true });
    writeFileSync(join(tempDir, '.hotsheet', 'settings.json'), JSON.stringify({}));
    mkdirSync(fakeBinDir, { recursive: true });
    initSkills(4174);
    setSkillCategories(DEFAULT_CATEGORIES);
    savedPath = process.env.PATH;
    process.env.PATH = fakeBinDir;
    // HS-8785 — `isExecutableOnPath` also searches `extraSearchDirs()`
    // (`~/.local/bin`, `~/.claude/local`, …), so PATH-only neutralization
    // leaks a dev machine's real `claude` install into these tests (the
    // "neither present" case would falsely detect it). `os.homedir()` honors
    // `$HOME` on POSIX — point it at the empty tempDir so those dirs resolve to
    // nothing; only the `fakeBinDir` we put on PATH should be discoverable.
    savedHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeFakeExecutable(name: string): void {
    // Empty file is enough — `isExecutableOnPath` uses `existsSync`,
    // not a chmod / shebang check.
    writeFileSync(join(fakeBinDir, name), '');
  }

  it('installs Claude skill when `claude` is on PATH even with no .claude folder', () => {
    writeFakeExecutable('claude');
    // No `.claude` folder created — pre-HS-8486 this branch would skip.
    const platforms = ensureSkillsForDir(tempDir);
    expect(platforms).toContain('Claude Code');
    expect(existsSync(join(tempDir, '.claude', 'skills', 'hotsheet', 'SKILL.md'))).toBe(true);
  });

  it('installs Cursor skill when `cursor` is on PATH even with no .cursor folder', () => {
    writeFakeExecutable('cursor');
    const platforms = ensureSkillsForDir(tempDir);
    expect(platforms).toContain('Cursor');
    expect(existsSync(join(tempDir, '.cursor', 'rules', 'hotsheet.mdc'))).toBe(true);
  });

  it('installs Windsurf skill when `windsurf` is on PATH even with no .windsurf folder', () => {
    writeFakeExecutable('windsurf');
    const platforms = ensureSkillsForDir(tempDir);
    expect(platforms).toContain('Windsurf');
    expect(existsSync(join(tempDir, '.windsurf', 'rules', 'hotsheet.md'))).toBe(true);
  });

  it('still installs Claude skill via the legacy folder-presence fallback when `claude` is NOT on PATH', () => {
    // Empty PATH (no claude binary), but the `.claude` folder exists
    // from a prior session. The folder check is preserved as a
    // fallback so projects in this state stay covered.
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    const platforms = ensureSkillsForDir(tempDir);
    expect(platforms).toContain('Claude Code');
  });

  it('does NOT install Claude skill when neither PATH nor folder are present', () => {
    const platforms = ensureSkillsForDir(tempDir);
    expect(platforms).not.toContain('Claude Code');
    expect(existsSync(join(tempDir, '.claude'))).toBe(false);
  });

  it('Copilot detection stays folder-only (no executable probe — Copilot lives inside VS Code)', () => {
    // Writing a fake `gh-copilot` to PATH must NOT trigger the
    // Copilot path — there's no reliable executable name for the
    // VS Code Copilot extension, so the gate stays folder-only.
    writeFakeExecutable('gh-copilot');
    const platforms = ensureSkillsForDir(tempDir);
    expect(platforms).not.toContain('GitHub Copilot');
  });
});
