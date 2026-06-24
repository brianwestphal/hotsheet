import { execSync } from 'child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { computeHotsheetGitignore, ensureGitignore, getGitRoot, HOTSHEET_GITIGNORE_RULES, isGitRepo, isHotsheetGitignored } from './gitignore.js';

// HS-8713 — compare two resolved paths for same-location equality in an
// OS-portable way. A bare `===` fails on Windows because `realpathSync` /
// `git rev-parse` disagree on drive-letter + dir casing (`C:\Windows\Temp`
// vs `C:\WINDOWS\TEMP`). `path.relative` is case-insensitive on win32 and
// returns '' for identical locations on every platform.
function samePath(a: string, b: string): boolean {
  return relative(a, b) === '';
}

function createTempDir(): string {
  const dir = join(tmpdir(), `hs-gitignore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  // Configure git user for the repo to avoid errors
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
}

describe('isGitRepo', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('returns true for a git repository', () => {
    tempDir = createTempDir();
    initGitRepo(tempDir);
    expect(isGitRepo(tempDir)).toBe(true);
  });

  it('returns false for a non-git directory', () => {
    tempDir = createTempDir();
    expect(isGitRepo(tempDir)).toBe(false);
  });
});

describe('getGitRoot', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('returns the root of a git repository', () => {
    tempDir = createTempDir();
    initGitRepo(tempDir);
    const root = getGitRoot(tempDir);
    // Resolve both paths since macOS /tmp is a symlink to /private/tmp
    expect(samePath(realpathSync(root!), realpathSync(tempDir))).toBe(true);
  });

  it('returns the root from a subdirectory', () => {
    tempDir = createTempDir();
    initGitRepo(tempDir);
    const subDir = join(tempDir, 'sub', 'dir');
    mkdirSync(subDir, { recursive: true });
    const root = getGitRoot(subDir);
    expect(samePath(realpathSync(root!), realpathSync(tempDir))).toBe(true);
  });

  it('returns null for a non-git directory', () => {
    tempDir = createTempDir();
    expect(getGitRoot(tempDir)).toBeNull();
  });
});

describe('isHotsheetGitignored', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('returns false when .hotsheet is not ignored', () => {
    tempDir = createTempDir();
    initGitRepo(tempDir);
    expect(isHotsheetGitignored(tempDir)).toBe(false);
  });

  it('returns true when .hotsheet/ is in .gitignore', () => {
    tempDir = createTempDir();
    initGitRepo(tempDir);
    // git check-ignore needs the path to exist
    mkdirSync(join(tempDir, '.hotsheet'), { recursive: true });
    writeFileSync(join(tempDir, '.gitignore'), '.hotsheet/\n');
    expect(isHotsheetGitignored(tempDir)).toBe(true);
  });
});

describe('computeHotsheetGitignore (HS-8989)', () => {
  const BLOCK = HOTSHEET_GITIGNORE_RULES.join('\n') + '\n';

  it('writes the canonical block when the file does not exist', () => {
    expect(computeHotsheetGitignore(null)).toBe(BLOCK);
  });

  it('appends the block to existing content', () => {
    expect(computeHotsheetGitignore('node_modules/\n')).toBe(`node_modules/\n${BLOCK}`);
  });

  it('replaces an older `.hotsheet/` (or bare `.hotsheet`) line', () => {
    expect(computeHotsheetGitignore('node_modules/\n.hotsheet/\n')).toBe(`node_modules/\n${BLOCK}`);
    expect(computeHotsheetGitignore('.hotsheet\n')).toBe(BLOCK);
    expect(computeHotsheetGitignore('/.hotsheet/\n')).toBe(BLOCK);
  });

  it('is a no-op when the canonical rules are already exactly present', () => {
    expect(computeHotsheetGitignore(BLOCK)).toBeNull();
    expect(computeHotsheetGitignore(`node_modules/\n${BLOCK}`)).toBeNull();
  });

  it('respects a commented-out opt-out (user manages it themselves)', () => {
    expect(computeHotsheetGitignore('# /.hotsheet/*\n# !/.hotsheet/settings.json\n')).toBeNull();
    expect(computeHotsheetGitignore('node_modules/\n# .hotsheet/\n')).toBeNull();
  });

  it('does not leave a trailing blank gap before the block', () => {
    expect(computeHotsheetGitignore('node_modules/\n\n\n')).toBe(`node_modules/\n${BLOCK}`);
  });

  it('writes the block to disk via ensureGitignore in a real repo (settings.json stays tracked)', () => {
    const dir = createTempDir();
    try {
      execSync('git init -q', { cwd: dir });
      writeFileSync(join(dir, '.gitignore'), '.hotsheet/\n');
      ensureGitignore(dir);
      const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
      expect(content).toContain('/.hotsheet/*');
      expect(content).toContain('!/.hotsheet/settings.json');
      expect(content).not.toMatch(/^\.hotsheet\/$/m); // old line replaced
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
