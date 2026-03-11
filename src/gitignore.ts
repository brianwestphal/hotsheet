import { execSync } from 'child_process';
import { appendFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

export function isHotsheetGitignored(repoRoot: string): boolean {
  try {
    execSync('git check-ignore -q .hotsheet', { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function isGitRepo(dir: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function getGitRoot(dir: string): string | null {
  try {
    return execSync('git rev-parse --show-toplevel', { cwd: dir, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

export function addHotsheetToGitignore(repoRoot: string): void {
  const gitignorePath = join(repoRoot, '.gitignore');

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    // Check if already has .hotsheet
    if (content.includes('.hotsheet')) return;
    // Add with a newline if needed
    const prefix = content.endsWith('\n') ? '' : '\n';
    appendFileSync(gitignorePath, `${prefix}.hotsheet/\n`);
  } else {
    appendFileSync(gitignorePath, '.hotsheet/\n');
  }
}

export function ensureGitignore(cwd: string): void {
  if (!isGitRepo(cwd)) return;
  const gitRoot = getGitRoot(cwd);
  if (gitRoot === null) return;
  if (!isHotsheetGitignored(gitRoot)) {
    addHotsheetToGitignore(gitRoot);
    console.log('  Added .hotsheet/ to .gitignore');
  }
}
