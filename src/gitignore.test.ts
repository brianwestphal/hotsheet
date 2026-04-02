import { execSync } from 'child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { addHotsheetToGitignore, getGitRoot, isGitRepo, isHotsheetGitignored } from './gitignore.js';

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
    expect(realpathSync(root!)).toBe(realpathSync(tempDir));
  });

  it('returns the root from a subdirectory', () => {
    tempDir = createTempDir();
    initGitRepo(tempDir);
    const subDir = join(tempDir, 'sub', 'dir');
    mkdirSync(subDir, { recursive: true });
    const root = getGitRoot(subDir);
    expect(realpathSync(root!)).toBe(realpathSync(tempDir));
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

describe('addHotsheetToGitignore', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('creates .gitignore with .hotsheet/ when it does not exist', () => {
    tempDir = createTempDir();
    addHotsheetToGitignore(tempDir);
    const content = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    expect(content).toBe('.hotsheet/\n');
  });

  it('appends .hotsheet/ to existing .gitignore', () => {
    tempDir = createTempDir();
    writeFileSync(join(tempDir, '.gitignore'), 'node_modules/\n');
    addHotsheetToGitignore(tempDir);
    const content = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    expect(content).toBe('node_modules/\n.hotsheet/\n');
  });

  it('adds newline before .hotsheet/ if file does not end with newline', () => {
    tempDir = createTempDir();
    writeFileSync(join(tempDir, '.gitignore'), 'node_modules/');
    addHotsheetToGitignore(tempDir);
    const content = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    expect(content).toBe('node_modules/\n.hotsheet/\n');
  });

  it('does not duplicate if .hotsheet is already present', () => {
    tempDir = createTempDir();
    writeFileSync(join(tempDir, '.gitignore'), '.hotsheet/\n');
    addHotsheetToGitignore(tempDir);
    const content = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    expect(content).toBe('.hotsheet/\n');
  });

  it('detects partial match (.hotsheet without slash) as already present', () => {
    tempDir = createTempDir();
    writeFileSync(join(tempDir, '.gitignore'), '.hotsheet\n');
    addHotsheetToGitignore(tempDir);
    const content = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    // Should not add again since content.includes('.hotsheet') is true
    expect(content).toBe('.hotsheet\n');
  });
});
