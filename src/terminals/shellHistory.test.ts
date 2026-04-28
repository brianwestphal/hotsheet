/**
 * HS-7965 — pure-helper tests for the per-(project, terminal-id) shell
 * history scoping module. The DOM-side / on-disk side (init-file
 * generation, settings reading) is exercised by the live spawn pipeline at
 * the e2e level — these tests pin the classification + content + command-
 * rewrite math.
 */
import { describe, expect, it } from 'vitest';

import {
  buildBashRc,
  buildFishConfig,
  buildZshRc,
  buildZshShim,
  classifyShellCommand,
  normaliseHistoryScope,
  rewriteBashCommand,
  sanitiseFishName,
  shellEscape,
} from './shellHistory.js';

describe('classifyShellCommand (HS-7965)', () => {
  it('matches bare shell names', () => {
    expect(classifyShellCommand('bash')).toBe('bash');
    expect(classifyShellCommand('zsh')).toBe('zsh');
    expect(classifyShellCommand('fish')).toBe('fish');
  });

  it('matches absolute paths', () => {
    expect(classifyShellCommand('/bin/bash')).toBe('bash');
    expect(classifyShellCommand('/usr/local/bin/zsh')).toBe('zsh');
    expect(classifyShellCommand('/usr/local/bin/fish')).toBe('fish');
  });

  it('matches with arguments', () => {
    expect(classifyShellCommand('/bin/zsh -i')).toBe('zsh');
    expect(classifyShellCommand('bash --login')).toBe('bash');
    expect(classifyShellCommand('fish --no-config')).toBe('fish');
  });

  it('strips Windows .exe extension and is case-insensitive', () => {
    // Note: a Windows path containing spaces would have to be quoted at the
    // settings layer for any shell-style splitter to handle it correctly;
    // we only handle space-free paths in the classifier (most users use
    // `C:\msys64\usr\bin\bash.exe` style).
    expect(classifyShellCommand('C:\\msys64\\usr\\bin\\bash.exe')).toBe('bash');
    expect(classifyShellCommand('BASH')).toBe('bash');
    expect(classifyShellCommand('Bash.EXE')).toBe('bash');
  });

  it('returns null for unrecognised commands', () => {
    expect(classifyShellCommand('claude')).toBeNull();
    expect(classifyShellCommand('claude --dangerously-load-development-channels server:hotsheet-channel')).toBeNull();
    expect(classifyShellCommand('npm run dev')).toBeNull();
    expect(classifyShellCommand('vim README.md')).toBeNull();
    expect(classifyShellCommand('sh')).toBeNull(); // sh / dash deliberately skipped
    expect(classifyShellCommand('pwsh')).toBeNull();
  });

  it('returns null for empty / whitespace input', () => {
    expect(classifyShellCommand('')).toBeNull();
    expect(classifyShellCommand('   ')).toBeNull();
  });
});

describe('normaliseHistoryScope (HS-7965)', () => {
  it('returns "per-terminal" for the unset / unknown / non-string default', () => {
    expect(normaliseHistoryScope(undefined)).toBe('per-terminal');
    expect(normaliseHistoryScope(null)).toBe('per-terminal');
    expect(normaliseHistoryScope('')).toBe('per-terminal');
    expect(normaliseHistoryScope('unknown')).toBe('per-terminal');
    expect(normaliseHistoryScope(42)).toBe('per-terminal');
  });

  it('respects an explicit "inherit"', () => {
    expect(normaliseHistoryScope('inherit')).toBe('inherit');
  });

  it('rejects "per-terminal" string input identity-checks too (defensive)', () => {
    expect(normaliseHistoryScope('per-terminal')).toBe('per-terminal');
  });
});

describe('shellEscape (HS-7965)', () => {
  it('wraps a simple path in single quotes', () => {
    expect(shellEscape('/tmp/a/b')).toBe(`'/tmp/a/b'`);
  });

  it('escapes embedded single quotes via the standard `\'\\\'\'` trick', () => {
    expect(shellEscape(`/tmp/it's`)).toBe(`'/tmp/it'\\''s'`);
  });

  it('handles paths with spaces, dollars, backslashes verbatim (single quotes preserve them)', () => {
    expect(shellEscape('/tmp/with space/$x\\y')).toBe(`'/tmp/with space/$x\\y'`);
  });
});

describe('sanitiseFishName (HS-7965)', () => {
  it('preserves alphanumeric + underscore', () => {
    expect(sanitiseFishName('claude_terminal_1')).toBe('claude_terminal_1');
  });

  it('replaces hyphens / dots / unicode with underscore (fish accepts only [A-Za-z0-9_])', () => {
    expect(sanitiseFishName('dyn-abc-123')).toBe('dyn_abc_123');
    expect(sanitiseFishName('default.tab')).toBe('default_tab');
    expect(sanitiseFishName('foo bar')).toBe('foo_bar');
  });
});

describe('buildBashRc (HS-7965)', () => {
  it('sources ~/.bashrc first then exports HISTFILE + reads it', () => {
    const out = buildBashRc('/proj/.hotsheet/shell_history/t1');
    expect(out).toContain(`source "$HOME/.bashrc"`);
    expect(out).toContain(`export HISTFILE='/proj/.hotsheet/shell_history/t1'`);
    expect(out).toContain(`history -r "$HISTFILE"`);
    // The source line precedes the override so the user rc loads FIRST.
    expect(out.indexOf('source "$HOME/.bashrc"')).toBeLessThan(out.indexOf('export HISTFILE'));
  });

  it('quotes the histfile path so spaces / quotes survive', () => {
    const out = buildBashRc(`/tmp/it's a/path`);
    expect(out).toContain(`export HISTFILE='/tmp/it'\\''s a/path'`);
  });
});

describe('buildZshRc (HS-7965)', () => {
  it('sources ~/.zshrc first then exports HISTFILE + fc -p', () => {
    const out = buildZshRc('/proj/.hotsheet/shell_history/t1');
    expect(out).toContain(`source "$HOME/.zshrc"`);
    expect(out).toContain(`export HISTFILE='/proj/.hotsheet/shell_history/t1'`);
    expect(out).toContain(`fc -p "$HISTFILE"`);
    expect(out.indexOf('source "$HOME/.zshrc"')).toBeLessThan(out.indexOf('export HISTFILE'));
  });
});

describe('buildZshShim (HS-7965)', () => {
  it('zshenv variant sources the user .zshenv', () => {
    expect(buildZshShim('zshenv')).toContain(`source "$HOME/.zshenv"`);
  });

  it('zprofile variant sources the user .zprofile', () => {
    expect(buildZshShim('zprofile')).toContain(`source "$HOME/.zprofile"`);
  });
});

describe('buildFishConfig (HS-7965)', () => {
  it('sources the user config first then sets fish_history', () => {
    const out = buildFishConfig('hotsheet_abcd1234_default');
    expect(out).toContain(`source "$HOME/.config/fish/config.fish"`);
    expect(out).toContain(`set -x fish_history hotsheet_abcd1234_default`);
    expect(out.indexOf('source')).toBeLessThan(out.indexOf('set -x'));
  });
});

describe('rewriteBashCommand (HS-7965)', () => {
  it('injects --rcfile after the bash invocation', () => {
    expect(rewriteBashCommand('bash', '/tmp/x.bashrc')).toBe(`bash --rcfile '/tmp/x.bashrc'`);
    expect(rewriteBashCommand('/bin/bash', '/tmp/x.bashrc')).toBe(`/bin/bash --rcfile '/tmp/x.bashrc'`);
  });

  it('preserves trailing arguments after the injected --rcfile', () => {
    expect(rewriteBashCommand('bash -i', '/tmp/x.bashrc')).toBe(`bash --rcfile '/tmp/x.bashrc' -i`);
  });

  it('skips rewrite when --rcfile is already present (defensive)', () => {
    const cmd = 'bash --rcfile /custom/x.bashrc';
    expect(rewriteBashCommand(cmd, '/tmp/y.bashrc')).toBe(cmd);
  });

  it('skips rewrite for login bash (-l / --login) — login shells dont read --rcfile', () => {
    expect(rewriteBashCommand('bash -l', '/tmp/x.bashrc')).toBe('bash -l');
    expect(rewriteBashCommand('bash --login', '/tmp/x.bashrc')).toBe('bash --login');
    expect(rewriteBashCommand('/bin/bash --login -i', '/tmp/x.bashrc')).toBe('/bin/bash --login -i');
  });

  it('quotes the rcfile path for safe shell embedding', () => {
    expect(rewriteBashCommand('bash', `/tmp/it's/x.bashrc`))
      .toBe(`bash --rcfile '/tmp/it'\\''s/x.bashrc'`);
  });
});
