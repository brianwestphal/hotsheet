import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveTerminalCommand } from './resolveCommand.js';

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
});
