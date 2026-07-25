import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claudeWithChannelCommand, commandUsesAiToken, resolveTerminalCommand, resolveTerminalCwd } from './resolveCommand.js';

// HS-8713 — same-location compare that ignores separator + drive-resolution
// differences. The cwd resolver returns native (`\`) or token-expanded
// (mixed-separator) paths on Windows, and the HS-7991 cases use POSIX literal
// project roots; `path.relative` resolves both to absolute and is
// case-insensitive on win32, returning '' for identical locations everywhere.
function samePath(a: string, b: string): boolean {
  return relative(a, b) === '';
}

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

  it('uses channel-enabled claude command with the per-project slug when channelEnabled + claude on PATH (HS-8349)', () => {
    const dataDir = dir();
    const { command } = resolveTerminalCommand({
      dataDir,
      isClaudeOnPath: () => true,
      channelEnabledOverride: true,
    });
    // Per-project slug-suffixed channel name — exact value depends on the
    // tempDir basename, so assert via the helper rather than a literal.
    expect(command).toBe(claudeWithChannelCommand(dataDir));
    expect(command.startsWith('claude --dangerously-load-development-channels server:hotsheet-channel-')).toBe(true);
  });

  // HS-8009 — `ai_tool`-aware resolution (docs/113 §113.3).
  it('ai_tool=gemini + gemini on PATH → launches the gemini binary', () => {
    const { command } = resolveTerminalCommand({
      dataDir: dir({ ai_tool: 'gemini' }),
      isAiToolOnPath: (b) => b === 'gemini',
    });
    expect(command).toBe('gemini');
  });

  it('ai_tool=codex resolves via the {{aiCommand}} alias too', () => {
    const { command } = resolveTerminalCommand({
      dataDir: dir({ terminal_command: 'env X=1 {{aiCommand}} --acp', ai_tool: 'codex' }),
      isAiToolOnPath: (b) => b === 'codex',
      codexModelB: false, // this case is about the bare binary; force model-A off the daemon socket
    });
    expect(command).toBe('env X=1 codex --acp');
  });

  it('ai_tool=gemini but NOT on PATH → falls back to the default shell', () => {
    const { command } = resolveTerminalCommand({
      dataDir: dir({ ai_tool: 'gemini' }),
      isAiToolOnPath: () => false,
      defaultShellOverride: () => '/bin/fake-shell',
    });
    expect(command).toBe('/bin/fake-shell');
  });

  // HS-9319 — Antigravity's binary is `agy`, not `antigravity`, so it exercises
  // the tool-id → binary map (unlike codex/gemini where id == binary).
  it('ai_tool=antigravity → launches the `agy` binary (tool id ≠ binary name)', () => {
    const { command } = resolveTerminalCommand({
      dataDir: dir({ ai_tool: 'antigravity' }),
      isAiToolOnPath: (b) => b === 'agy',
    });
    expect(command).toBe('agy');
  });

  it('ai_tool=antigravity probes the `agy` binary on PATH, not the `antigravity` id', () => {
    const { command } = resolveTerminalCommand({
      dataDir: dir({ ai_tool: 'antigravity' }),
      isAiToolOnPath: (b) => b === 'antigravity', // the id itself is NOT the binary
      defaultShellOverride: () => '/bin/fake-shell',
    });
    expect(command).toBe('/bin/fake-shell');
  });

  it('ai_tool=antigravity resolves the {{aiCommand}} alias to `agy` too', () => {
    const { command } = resolveTerminalCommand({
      dataDir: dir({ terminal_command: '{{aiCommand}} --print', ai_tool: 'antigravity' }),
      isAiToolOnPath: (b) => b === 'agy',
    });
    expect(command).toBe('agy --print');
  });

  it('ai_tool=auto keeps today\'s Claude channel behavior', () => {
    const dataDir = dir({ ai_tool: 'auto' });
    const { command } = resolveTerminalCommand({
      dataDir, isClaudeOnPath: () => true, channelEnabledOverride: true,
    });
    expect(command).toBe(claudeWithChannelCommand(dataDir));
  });

  it('ai_tool=cursor (an editor tool, not a terminal agent) falls back to Claude behavior', () => {
    const { command } = resolveTerminalCommand({
      dataDir: dir({ ai_tool: 'cursor' }),
      isClaudeOnPath: () => true,
      channelEnabledOverride: false,
    });
    expect(command).toBe('claude');
  });

  it('produces distinct channel commands for distinct project dataDirs (HS-8349)', () => {
    const dataDirA = dir();
    const dataDirB = dir();
    const a = resolveTerminalCommand({ dataDir: dataDirA, isClaudeOnPath: () => true, channelEnabledOverride: true }).command;
    const b = resolveTerminalCommand({ dataDir: dataDirB, isClaudeOnPath: () => true, channelEnabledOverride: true }).command;
    expect(a).not.toBe(b);
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
    expect(samePath(cwd, join(dirname(dataDir), 'scratch'))).toBe(true);
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

describe('commandUsesAiToken (HS-9333)', () => {
  it('is true for either AI-tool placeholder, embedded anywhere', () => {
    expect(commandUsesAiToken('{{claudeCommand}}')).toBe(true);
    expect(commandUsesAiToken('{{aiCommand}}')).toBe(true);
    expect(commandUsesAiToken('wt: {{aiCommand}} --flag')).toBe(true);
  });
  it('is false for a command with no placeholder', () => {
    expect(commandUsesAiToken('claude')).toBe(false);
    expect(commandUsesAiToken('/bin/zsh')).toBe(false);
    expect(commandUsesAiToken('')).toBe(false);
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
    expect(samePath(resolveTerminalCwd('foo', PROJECT), '/abs/project/foo')).toBe(true);
  });

  it('resolves ./relative paths against the project root', () => {
    expect(samePath(resolveTerminalCwd('./foo', PROJECT), '/abs/project/foo')).toBe(true);
  });

  it('resolves ../parent paths against the project root', () => {
    expect(samePath(resolveTerminalCwd('../sibling', PROJECT), '/abs/sibling')).toBe(true);
  });
});

// HS-9394 (docs/123) — codex terminals join the project's driven app-server thread.
describe('codex daemon-attach resolution (HS-9394)', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
    cleanup.length = 0;
  });
  function dir(settings: Record<string, unknown> = {}): string {
    const d = makeDataDir(settings);
    cleanup.push(d);
    return d;
  }

  it('uses the attach command when the resolver provides one', () => {
    const { command } = resolveTerminalCommand({
      dataDir: dir({ ai_tool: 'codex' }),
      isAiToolOnPath: (b) => b === 'codex',
      codexAttachOverride: () => "codex resume th-1 --remote 'unix:///s.sock'",
      codexModelB: false,
    });
    expect(command).toBe("codex resume th-1 --remote 'unix:///s.sock'");
  });

  it('expands inside a {{aiCommand}} template as well', () => {
    const { command } = resolveTerminalCommand({
      dataDir: dir({ terminal_command: 'env X=1 {{aiCommand}}', ai_tool: 'codex' }),
      isAiToolOnPath: (b) => b === 'codex',
      codexAttachOverride: () => "codex resume th-1 --remote 'unix:///s.sock'",
      codexModelB: false,
    });
    expect(command).toBe("env X=1 codex resume th-1 --remote 'unix:///s.sock'");
  });

  it('falls back to plain codex when the attach resolver returns null', () => {
    const { command } = resolveTerminalCommand({
      dataDir: dir({ ai_tool: 'codex' }),
      isAiToolOnPath: (b) => b === 'codex',
      codexAttachOverride: () => null,
      codexModelB: false,
    });
    expect(command).toBe('codex');
  });

  it('never consults the attach resolver for non-codex tools', () => {
    let called = false;
    const { command } = resolveTerminalCommand({
      dataDir: dir({ ai_tool: 'gemini' }),
      isAiToolOnPath: (b) => b === 'gemini',
      codexAttachOverride: () => { called = true; return 'nope'; },
    });
    expect(command).toBe('gemini');
    expect(called).toBe(false);
  });
});

// HS-9429 (docs/129 model-B) — with the discovery gate on, a codex terminal
// launches DAEMON-HOSTED (`codex --remote … -C`) instead of the model-A attach.
describe('codex model-B daemon-hosted resolution (HS-9429)', () => {
  const cleanup: string[] = [];
  const dir = (settings: Record<string, unknown>): string => { const d = makeDataDir(settings); cleanup.push(d); return d; };
  afterEach(() => { for (const d of cleanup.splice(0)) rmSync(dirname(d), { recursive: true, force: true }); });

  it('uses the model-B remote command when the gate is on and the resolver provides one', () => {
    const { command } = resolveTerminalCommand({
      dataDir: dir({ ai_tool: 'codex' }),
      isAiToolOnPath: (b) => b === 'codex',
      codexModelB: true,
      codexRemoteOverride: () => "codex --remote 'unix:///s.sock' -C '/proj'",
      // If model-B is picked, the attach resolver must NOT be consulted.
      codexAttachOverride: () => { throw new Error('attach should not run under model-B'); },
    });
    expect(command).toBe("codex --remote 'unix:///s.sock' -C '/proj'");
  });

  it('expands inside a {{aiCommand}} template', () => {
    const { command } = resolveTerminalCommand({
      dataDir: dir({ terminal_command: 'env X=1 {{aiCommand}}', ai_tool: 'codex' }),
      isAiToolOnPath: (b) => b === 'codex',
      codexModelB: true,
      codexRemoteOverride: () => "codex --remote 'unix:///s.sock' -C '/proj'",
    });
    expect(command).toBe("env X=1 codex --remote 'unix:///s.sock' -C '/proj'");
  });

  it('falls back to plain codex when the daemon is not up (remote resolver returns null)', () => {
    const { command } = resolveTerminalCommand({
      dataDir: dir({ ai_tool: 'codex' }),
      isAiToolOnPath: (b) => b === 'codex',
      codexModelB: true,
      codexRemoteOverride: () => null,
    });
    expect(command).toBe('codex');
  });

  it('uses the model-A attach (not the remote command) when the gate is OFF', () => {
    const { command } = resolveTerminalCommand({
      dataDir: dir({ ai_tool: 'codex' }),
      isAiToolOnPath: (b) => b === 'codex',
      codexModelB: false,
      codexAttachOverride: () => "codex resume th-1 --remote 'unix:///s.sock'",
      codexRemoteOverride: () => { throw new Error('remote should not run under model-A'); },
    });
    expect(command).toBe("codex resume th-1 --remote 'unix:///s.sock'");
  });
});
