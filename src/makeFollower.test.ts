/**
 * HS-9688 — `makeFollower` adopts a git worktree as a follower of an owner's Hot Sheet:
 * it writes the `authoritativeDataDir` pointer + wires the channel/skills/allow-rules
 * against the owner, so the runtime redirect (`resolveAuthoritativeDataDir`) then routes
 * the worktree's project data to the owner's one DB / instance.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveAuthoritativeDataDir, writeFileSettings } from './file-settings.js';
import { makeFollower, resolveOwnerDataDir } from './makeFollower.js';

let base: string;
let ownerRoot: string;
let ownerHotsheet: string;
let worktreeRoot: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'hs-makefollower-'));
  ownerRoot = join(base, 'owner');
  ownerHotsheet = join(ownerRoot, '.hotsheet');
  worktreeRoot = join(base, 'worktree');
  mkdirSync(ownerHotsheet, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  // A valid (non-follower) owner .hotsheet.
  writeFileSettings(ownerHotsheet, { appName: 'Owner', port: 4174 });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('resolveOwnerDataDir', () => {
  it('appends .hotsheet to a project root', () => {
    expect(resolveOwnerDataDir(ownerRoot)).toBe(ownerHotsheet);
  });
  it('leaves an explicit .hotsheet dir unchanged', () => {
    expect(resolveOwnerDataDir(ownerHotsheet)).toBe(ownerHotsheet);
  });
});

describe('makeFollower', () => {
  it('wires the follower so the runtime redirect resolves to the owner', () => {
    makeFollower(worktreeRoot, ownerHotsheet);
    const followerDataDir = join(worktreeRoot, '.hotsheet');

    // The pointer is written and the redirect resolves to the owner — the whole point.
    expect(resolveAuthoritativeDataDir(followerDataDir)).toBe(ownerHotsheet);
    // Channel MCP config is written at the worktree root, pointed at the OWNER's dir.
    const mcpPath = join(worktreeRoot, '.mcp.json');
    expect(existsSync(mcpPath)).toBe(true);
    expect(readFileSync(mcpPath, 'utf-8')).toContain(ownerHotsheet);
    // (ensureGitignore is git-gated — a no-op outside a git repo, which real worktrees
    //  always are; its behavior is covered by gitignore's own tests.)
  });

  it('is idempotent (re-adopting the same owner does not throw or change the target)', () => {
    makeFollower(worktreeRoot, ownerHotsheet);
    makeFollower(worktreeRoot, ownerHotsheet);
    expect(resolveAuthoritativeDataDir(join(worktreeRoot, '.hotsheet'))).toBe(ownerHotsheet);
  });

  it('throws when the owner .hotsheet does not exist', () => {
    expect(() => makeFollower(worktreeRoot, join(base, 'nope', '.hotsheet'))).toThrow(/does not exist/);
  });

  it('refuses a self-reference (owner === this worktree .hotsheet)', () => {
    const dir = join(worktreeRoot, '.hotsheet');
    mkdirSync(dir, { recursive: true });
    expect(() => makeFollower(worktreeRoot, dir)).toThrow(/follow itself/);
  });

  it('refuses to follow an owner that is itself a follower (no chains)', () => {
    // Make the "owner" a follower of a third dir.
    const grand = join(base, 'grand', '.hotsheet');
    mkdirSync(grand, { recursive: true });
    writeFileSettings(ownerHotsheet, { authoritativeDataDir: grand });
    expect(() => makeFollower(worktreeRoot, ownerHotsheet)).toThrow(/itself a follower|chains/);
  });
});
