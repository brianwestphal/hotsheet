import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveTerminalCommand, resolveTerminalCwd } from './resolveCommand.js';

function makeDataDir(settings: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'hs-resolve-'));
  const dataDir = join(root, '.hotsheet');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings));
  return dataDir;
}

describe('resolveTerminalCommand', () => {
  const cleanup: string[] = [];
  beforeEach(() => { cleanup.length = 0; });
  afterEach(() => {
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  });

  function dir(settings: Record<string, unknown> = {}): string {
    const d = makeDataDir(settings);
    cleanup.push(d);
    return d;
  }

  it('uses channel-enabled claude command when channelEnabled + claude on PATH', () => {
    const { command } = resolveTerminalCommand({
      dataDir: dir(),
      isClaudeOnPath: () => true,
      channelEnabledOverride: true,
    });
    expect(command).toBe('claude --dangerously-load-development-channels server:hotsheet-channel');
  });

  it('uses plain claude when channel is disabled but claude is on PATH', () => {
    const { command } = resolveTerminalCommand({
      dataDir: dir(),
      isClaudeOnPath: () => true,
      channelEnabledOverride: false,
    });
    expect(command).toBe('claude');
  });

  it('falls back to the default shell when claude is not on PATH', () => {
    const { command } = resolveTerminalCommand({
      dataDir: dir(),
      isClaudeOnPath: () => false,
      channelEnabledOverride: true,
      defaultShellOverride: () => '/bin/fake-shell',
    });
    expect(command).toBe('/bin/fake-shell');
  });

  it('passes terminal_command verbatim when it contains no template tokens', () => {
    const { command } = resolveTerminalCommand({
      dataDir: dir({ terminal_command: '/usr/local/bin/custom-tool --flag' }),
      isClaudeOnPath: () => true,
      channelEnabledOverride: true,
    });
    expect(command).toBe('/usr/local/bin/custom-tool --flag');
  });

  it('substitutes the token inside a longer template', () => {
    const { command } = resolveTerminalCommand({
      dataDir: dir({ terminal_command: 'env FOO=bar {{claudeCommand}} --extra' }),
      isClaudeOnPath: () => true,
      channelEnabledOverride: false,
    });
    expect(command).toBe('env FOO=bar claude --extra');
  });

  it('defaults cwd to the parent of the data directory (project root)', () => {
    const dataDir = dir();
    const { cwd } = resolveTerminalCommand({
      dataDir,
      isClaudeOnPath: () => true,
      channelEnabledOverride: false,
    });
    expect(cwd).toBe(dirname(dataDir));
  });

  it('honors terminal_cwd when set', () => {
    const { cwd } = resolveTerminalCommand({
      dataDir: dir({ terminal_cwd: '/some/override' }),
      isClaudeOnPath: () => true,
      channelEnabledOverride: false,
    });
    expect(cwd).toBe('/some/override');
  });

  // HS-7991 — projectDir template + relative-path resolution.
  it('expands {{projectDir}} in the cwd setting', () => {
    const dataDir = dir({ terminal_cwd: '{{projectDir}}/scratch' });
    const { cwd } = resolveTerminalCommand({
      dataDir,
      isClaudeOnPath: () => true,
      channelEnabledOverride: false,
    });
    expect(cwd).toBe(join(dirname(dataDir), 'scratch'));
  });

  it('resolves relative paths against the project root', () => {
    const dataDir = dir({ terminal_cwd: 'sub-folder' });
    const { cwd } = resolveTerminalCommand({
      dataDir,
      isClaudeOnPath: () => true,
      channelEnabledOverride: false,
    });
    expect(cwd).toBe(join(dirname(dataDir), 'sub-folder'));
  });

  it('resolves ./prefixed relative paths against the project root', () => {
    const dataDir = dir({ terminal_cwd: './scratch' });
    const { cwd } = resolveTerminalCommand({
      dataDir,
      isClaudeOnPath: () => true,
      channelEnabledOverride: false,
    });
    expect(cwd).toBe(join(dirname(dataDir), 'scratch'));
  });
});

describe('resolveTerminalCwd (HS-7991)', () => {
  const PROJECT = '/abs/project';

  it('returns project root when blank', () => {
    expect(resolveTerminalCwd('', PROJECT)).toBe(PROJECT);
    expect(resolveTerminalCwd(undefined, PROJECT)).toBe(PROJECT);
  });

  it('trims surrounding whitespace before deciding', () => {
    expect(resolveTerminalCwd('   ', PROJECT)).toBe(PROJECT);
  });

  it('expands {{projectDir}} alone', () => {
    expect(resolveTerminalCwd('{{projectDir}}', PROJECT)).toBe(PROJECT);
  });

  it('expands {{projectDir}} as a prefix', () => {
    expect(resolveTerminalCwd('{{projectDir}}/foo', PROJECT)).toBe('/abs/project/foo');
  });

  it('uses absolute paths verbatim', () => {
    expect(resolveTerminalCwd('/elsewhere', PROJECT)).toBe('/elsewhere');
  });

  it('resolves bare relative paths against the project root', () => {
    expect(resolveTerminalCwd('foo', PROJECT)).toBe('/abs/project/foo');
  });

  it('resolves ./relative paths against the project root', () => {
    expect(resolveTerminalCwd('./foo', PROJECT)).toBe('/abs/project/foo');
  });

  it('resolves ../parent paths against the project root', () => {
    expect(resolveTerminalCwd('../sibling', PROJECT)).toBe('/abs/sibling');
  });
});
