// HS-8376 / HS-8377 — unit tests for the `.claude/settings.local.json`
// auto-allow-rule writer. Covers every case enumerated in §64.4 of the
// design doc.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claudeAllowRulePattern, syncClaudeAllowRule, unsyncClaudeAllowRule } from './claude-allow-rule.js';

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
