// HS-8376 / HS-8377 — unit tests for the `.claude/settings.local.json`
// auto-allow-rule writer. Covers every case enumerated in §64.4 of the
// design doc.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getMcpServerKey } from './channel-config.js';
import { claudeAllowRulePattern, syncClaudeAllowRule, unsyncClaudeAllowRule, writeWorktreeApprovals } from './claude-allow-rule.js';

let tempDir: string;
let dataDir: string;
let claudeDir: string;
let settingsPath: string;

function setupProject(): void {
  tempDir = join(tmpdir(), `hs-allow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  dataDir = join(tempDir, '.hotsheet');
  mkdirSync(dataDir, { recursive: true });
  claudeDir = join(tempDir, '.claude');
  settingsPath = join(claudeDir, 'settings.local.json');
}

function writeProjectSettings(json: Record<string, unknown>): void {
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(json), 'utf-8');
}

function readSettings(): { permissions: { allow: string[] }; [k: string]: unknown } {
  return JSON.parse(readFileSync(settingsPath, 'utf-8')) as { permissions: { allow: string[] }; [k: string]: unknown };
}

beforeEach(() => {
  setupProject();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('claudeAllowRulePattern (HS-8377)', () => {
  it('embeds the HS-8349 slug into the pattern after the second `__`', () => {
    // Project basename `mytest-…` → slug `mytest-…`; rule is
    // `mcp__hotsheet-channel-<slug>__*`. The trailing `*` is the wildcard
    // Claude Code expands at match time.
    const rule = claudeAllowRulePattern(dataDir);
    expect(rule.startsWith('mcp__hotsheet-channel-')).toBe(true);
    expect(rule.endsWith('__*')).toBe(true);
  });

  it('produces distinct rules for distinct project dataDirs (HS-8349 parity)', () => {
    const otherDir = join(tmpdir(), `hs-allow-other-${Math.random().toString(36).slice(2)}`, '.hotsheet');
    expect(claudeAllowRulePattern(dataDir)).not.toBe(claudeAllowRulePattern(otherDir));
  });
});

describe('syncClaudeAllowRule (HS-8377)', () => {
  it('§64.2 D4 — no-op when `.claude/` is absent (user not using Claude Code on this project)', () => {
    // No mkdirSync on claudeDir.
    syncClaudeAllowRule(dataDir);
    expect(existsSync(settingsPath)).toBe(false);
    // And no error.
  });

  it('§64.2 D3 — creates `.claude/settings.local.json` with minimal shape when `.claude/` exists but the file does not', () => {
    mkdirSync(claudeDir);
    syncClaudeAllowRule(dataDir);
    expect(existsSync(settingsPath)).toBe(true);
    const settings = readSettings();
    expect(settings.permissions.allow).toEqual([claudeAllowRulePattern(dataDir)]);
  });

  it('appends the rule to an existing `allow` array without re-ordering pre-existing entries', () => {
    mkdirSync(claudeDir);
    writeFileSync(settingsPath, JSON.stringify({
      permissions: { allow: ['Bash(npm *)', 'WebFetch(domain:registry.npmjs.org)'] },
    }, null, 2) + '\n');
    syncClaudeAllowRule(dataDir);
    const settings = readSettings();
    expect(settings.permissions.allow).toEqual([
      'Bash(npm *)',
      'WebFetch(domain:registry.npmjs.org)',
      claudeAllowRulePattern(dataDir),
    ]);
  });

  it('§64.2 D5 — idempotent: rule already present → byte-identical no-op', () => {
    mkdirSync(claudeDir);
    const existing = {
      permissions: { allow: ['Bash(npm *)', claudeAllowRulePattern(dataDir)] },
    };
    const initial = JSON.stringify(existing, null, 2) + '\n';
    writeFileSync(settingsPath, initial);
    syncClaudeAllowRule(dataDir);
    // Byte-identical — neither the rule order, the indent, nor the
    // trailing newline should have changed.
    expect(readFileSync(settingsPath, 'utf-8')).toBe(initial);
  });

  it('preserves unrelated top-level keys verbatim (model, env, ...)', () => {
    mkdirSync(claudeDir);
    writeFileSync(settingsPath, JSON.stringify({
      model: 'claude-opus-4-7',
      env: { FOO: 'bar' },
      permissions: { allow: ['Bash(npm *)'] },
    }));
    syncClaudeAllowRule(dataDir);
    const settings = readSettings();
    expect(settings.model).toBe('claude-opus-4-7');
    expect(settings.env).toEqual({ FOO: 'bar' });
  });

  it('§64.2 D6 — malformed JSON: warns + leaves the file unchanged (no throw)', () => {
    mkdirSync(claudeDir);
    const bogus = '{ this is not json';
    writeFileSync(settingsPath, bogus);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
    expect(() => { syncClaudeAllowRule(dataDir); }).not.toThrow();
    expect(readFileSync(settingsPath, 'utf-8')).toBe(bogus);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('§64.2 D7 — `claude_auto_allow_rule: false` in settings.json → no-op', () => {
    mkdirSync(claudeDir);
    writeProjectSettings({ claude_auto_allow_rule: false });
    syncClaudeAllowRule(dataDir);
    // File was never created — the opt-out gate short-circuits before
    // any read or write of settings.local.json.
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('§64.2 D7 — `claude_auto_allow_rule: true` (explicit) → writes as normal', () => {
    mkdirSync(claudeDir);
    writeProjectSettings({ claude_auto_allow_rule: true });
    syncClaudeAllowRule(dataDir);
    expect(existsSync(settingsPath)).toBe(true);
    expect(readSettings().permissions.allow).toContain(claudeAllowRulePattern(dataDir));
  });

  it('§64.2 D7 — missing setting (default-on) → writes as normal', () => {
    mkdirSync(claudeDir);
    // No settings.json at all → readFileSettings returns {} → opt-out
    // gate reads `undefined !== false` → enabled.
    syncClaudeAllowRule(dataDir);
    expect(existsSync(settingsPath)).toBe(true);
  });

  it('multi-project: two distinct dataDirs produce distinct allow rules in their own files', () => {
    // First project — already set up via beforeEach.
    mkdirSync(claudeDir);
    syncClaudeAllowRule(dataDir);
    const firstRule = claudeAllowRulePattern(dataDir);

    // Second project — totally separate temp dir.
    const otherRoot = join(tmpdir(), `hs-allow-other-${Math.random().toString(36).slice(2)}`);
    const otherDataDir = join(otherRoot, '.hotsheet');
    const otherClaudeDir = join(otherRoot, '.claude');
    const otherSettings = join(otherClaudeDir, 'settings.local.json');
    mkdirSync(otherDataDir, { recursive: true });
    mkdirSync(otherClaudeDir, { recursive: true });
    syncClaudeAllowRule(otherDataDir);
    const secondRule = claudeAllowRulePattern(otherDataDir);

    expect(firstRule).not.toBe(secondRule);
    type ClaudeJson = { permissions: { allow: string[] } };
    expect((JSON.parse(readFileSync(settingsPath, 'utf-8')) as ClaudeJson).permissions.allow).toEqual([firstRule]);
    expect((JSON.parse(readFileSync(otherSettings, 'utf-8')) as ClaudeJson).permissions.allow).toEqual([secondRule]);

    rmSync(otherRoot, { recursive: true, force: true });
  });

  it('uses 2-space indent + trailing newline (matches Claude Code convention)', () => {
    mkdirSync(claudeDir);
    syncClaudeAllowRule(dataDir);
    const raw = readFileSync(settingsPath, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    // 2-space indent — the first nested key appears after a 2-space prefix.
    expect(raw).toMatch(/\n {2}"permissions":/);
  });
});

describe('unsyncClaudeAllowRule (HS-8377)', () => {
  it('removes the rule when present + preserves other entries', () => {
    mkdirSync(claudeDir);
    const rule = claudeAllowRulePattern(dataDir);
    writeFileSync(settingsPath, JSON.stringify({
      permissions: { allow: ['Bash(npm *)', rule, 'WebFetch(domain:example.com)'] },
    }));
    unsyncClaudeAllowRule(dataDir);
    expect(readSettings().permissions.allow).toEqual(['Bash(npm *)', 'WebFetch(domain:example.com)']);
  });

  it('no-op when the rule is absent (unrelated entries untouched)', () => {
    mkdirSync(claudeDir);
    const initial = JSON.stringify({
      permissions: { allow: ['Bash(npm *)'] },
    }, null, 2) + '\n';
    writeFileSync(settingsPath, initial);
    unsyncClaudeAllowRule(dataDir);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(initial);
  });

  it('no-op when `.claude/settings.local.json` does not exist', () => {
    mkdirSync(claudeDir);
    // No settings.local.json file. unsync should be silent.
    expect(() => { unsyncClaudeAllowRule(dataDir); }).not.toThrow();
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('no-op when `claude_auto_allow_rule: false` (respects opt-out even on disable)', () => {
    mkdirSync(claudeDir);
    const rule = claudeAllowRulePattern(dataDir);
    const initial = JSON.stringify({ permissions: { allow: [rule] } });
    writeFileSync(settingsPath, initial);
    writeProjectSettings({ claude_auto_allow_rule: false });
    unsyncClaudeAllowRule(dataDir);
    // File untouched — the user opted out of Hot Sheet managing this file
    // entirely, so we don't even remove a rule we previously wrote.
    expect(readFileSync(settingsPath, 'utf-8')).toBe(initial);
  });

  it('malformed JSON: warns + leaves the file unchanged (no throw)', () => {
    mkdirSync(claudeDir);
    const bogus = '{ this is not json';
    writeFileSync(settingsPath, bogus);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
    expect(() => { unsyncClaudeAllowRule(dataDir); }).not.toThrow();
    expect(readFileSync(settingsPath, 'utf-8')).toBe(bogus);
    expect(warnSpy).toHaveBeenCalled();
  });
});

// HS-9058 (docs/104 §104.4) — the worktree approvals writer. A git worktree is
// a follower of the owner project: its `.claude/settings.local.json` is at the
// WORKTREE root, while the opt-out + server slug come from the OWNER's dataDir.
describe('writeWorktreeApprovals (HS-9058, docs/104)', () => {
  // A separate worktree root (distinct from the owner `tempDir`/`dataDir` set up
  // in beforeEach), so the regression guard can assert the OWNER root is never
  // touched.
  let worktreeRoot: string;
  let worktreeClaudeDir: string;
  let worktreeSettings: string;

  const SKILLS = ['hotsheet', 'hotsheet-worker', 'hs-bug'];

  function setupWorktree(): void {
    worktreeRoot = join(tmpdir(), `hs-wt-approve-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    worktreeClaudeDir = join(worktreeRoot, '.claude');
    worktreeSettings = join(worktreeClaudeDir, 'settings.local.json');
    mkdirSync(worktreeClaudeDir, { recursive: true });
  }

  function readWorktreeSettings(): { enabledMcpjsonServers?: string[]; permissions: { allow: string[] }; [k: string]: unknown } {
    return JSON.parse(readFileSync(worktreeSettings, 'utf-8')) as { enabledMcpjsonServers?: string[]; permissions: { allow: string[] }; [k: string]: unknown };
  }

  beforeEach(() => {
    setupWorktree();
  });

  afterEach(() => {
    rmSync(worktreeRoot, { recursive: true, force: true });
  });

  it('writes enabledMcpjsonServers + the tool wildcard + a Skill() rule per generated skill', () => {
    writeWorktreeApprovals(worktreeRoot, dataDir, SKILLS);
    const serverKey = getMcpServerKey(dataDir);
    const settings = readWorktreeSettings();
    expect(settings.enabledMcpjsonServers).toEqual([serverKey]);
    expect(settings.permissions.allow).toContain(`mcp__${serverKey}__*`);
    expect(settings.permissions.allow).toContain('Skill(hotsheet)');
    expect(settings.permissions.allow).toContain('Skill(hotsheet-worker)');
    expect(settings.permissions.allow).toContain('Skill(hs-bug)');
    // The tool wildcard matches claudeAllowRulePattern for the OWNER dataDir.
    expect(settings.permissions.allow).toContain(claudeAllowRulePattern(dataDir));
  });

  it('merges with a pre-existing settings.local.json — preserves unrelated keys + existing allow entries', () => {
    writeFileSync(worktreeSettings, JSON.stringify({
      model: 'claude-opus-4-8',
      env: { FOO: 'bar' },
      enabledMcpjsonServers: ['some-other-server'],
      permissions: { allow: ['Bash(npm *)'] },
    }, null, 2) + '\n');
    writeWorktreeApprovals(worktreeRoot, dataDir, SKILLS);
    const serverKey = getMcpServerKey(dataDir);
    const settings = readWorktreeSettings();
    // Unrelated top-level keys round-trip verbatim.
    expect(settings.model).toBe('claude-opus-4-8');
    expect(settings.env).toEqual({ FOO: 'bar' });
    // Existing server entry kept; ours appended.
    expect(settings.enabledMcpjsonServers).toEqual(['some-other-server', serverKey]);
    // Existing allow entry kept; ours appended after it.
    expect(settings.permissions.allow[0]).toBe('Bash(npm *)');
    expect(settings.permissions.allow).toContain(`mcp__${serverKey}__*`);
    expect(settings.permissions.allow).toContain('Skill(hotsheet-worker)');
  });

  it('is idempotent — a second call neither duplicates entries nor rewrites the file', () => {
    writeWorktreeApprovals(worktreeRoot, dataDir, SKILLS);
    const afterFirst = readFileSync(worktreeSettings, 'utf-8');
    writeWorktreeApprovals(worktreeRoot, dataDir, SKILLS);
    // Byte-identical — no duplicate server keys or allow rules, no churn.
    expect(readFileSync(worktreeSettings, 'utf-8')).toBe(afterFirst);
    const settings = readWorktreeSettings();
    const serverKey = getMcpServerKey(dataDir);
    expect(settings.enabledMcpjsonServers).toEqual([serverKey]);
    expect(settings.permissions.allow.filter(r => r === 'Skill(hotsheet)')).toHaveLength(1);
  });

  it('§104.2 regression guard — targets the WORKTREE root, never the owner root', () => {
    // The owner project has its own `.claude/` (distinct from the worktree's).
    mkdirSync(claudeDir, { recursive: true });
    writeWorktreeApprovals(worktreeRoot, dataDir, SKILLS);
    // Worktree file written…
    expect(existsSync(worktreeSettings)).toBe(true);
    // …and the OWNER's `.claude/settings.local.json` was NOT created. This is the
    // bug: `syncClaudeAllowRule` derived `.claude/` from the owner root, so a
    // worktree's approvals never landed (and conversely the owner must stay clean
    // here — the writer is worktree-scoped).
    expect(existsSync(settingsPath)).toBe(false);
  });

  it("respects the OWNER's claude_auto_allow_rule:false opt-out → writes nothing", () => {
    writeProjectSettings({ claude_auto_allow_rule: false });
    writeWorktreeApprovals(worktreeRoot, dataDir, SKILLS);
    expect(existsSync(worktreeSettings)).toBe(false);
  });

  it("respects the OWNER's claude_auto_allow_rule:true (explicit) → writes as normal", () => {
    writeProjectSettings({ claude_auto_allow_rule: true });
    writeWorktreeApprovals(worktreeRoot, dataDir, SKILLS);
    expect(existsSync(worktreeSettings)).toBe(true);
  });

  it('no-op when the worktree has no `.claude/` directory (worker not using Claude Code)', () => {
    rmSync(worktreeClaudeDir, { recursive: true, force: true });
    writeWorktreeApprovals(worktreeRoot, dataDir, SKILLS);
    expect(existsSync(worktreeSettings)).toBe(false);
  });

  it('malformed JSON: warns + leaves the worktree file unchanged (no throw)', () => {
    const bogus = '{ this is not json';
    writeFileSync(worktreeSettings, bogus);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
    expect(() => { writeWorktreeApprovals(worktreeRoot, dataDir, SKILLS); }).not.toThrow();
    expect(readFileSync(worktreeSettings, 'utf-8')).toBe(bogus);
    expect(warnSpy).toHaveBeenCalled();
  });
});
