import { describe, expect, it } from 'vitest';

import { buildAskClaudePrompt, computeLastOutputRange, exitCodeGutterClass, findPromptLine, parseOsc133ExitCode } from './terminalOsc133.js';

describe('parseOsc133ExitCode (HS-7267)', () => {
  it('returns null for bare "D" (no exit code reported)', () => {
    expect(parseOsc133ExitCode('D')).toBeNull();
  });

  it('parses "D;0" as exit code 0 (success)', () => {
    expect(parseOsc133ExitCode('D;0')).toBe(0);
  });

  it('parses "D;1" as exit code 1 (generic failure)', () => {
    expect(parseOsc133ExitCode('D;1')).toBe(1);
  });

  it('parses "D;130" (SIGINT) / "D;137" (SIGKILL) / "D;143" (SIGTERM)', () => {
    expect(parseOsc133ExitCode('D;130')).toBe(130);
    expect(parseOsc133ExitCode('D;137')).toBe(137);
    expect(parseOsc133ExitCode('D;143')).toBe(143);
  });

  it('truncates at the first `;` so VS Code 633 extensions (D;0;cwd=...) still parse', () => {
    expect(parseOsc133ExitCode('D;0;cwd=/Users/me')).toBe(0);
    expect(parseOsc133ExitCode('D;1;aid=abc')).toBe(1);
  });

  it('returns null for non-numeric exit codes', () => {
    expect(parseOsc133ExitCode('D;abc')).toBeNull();
    expect(parseOsc133ExitCode('D;')).toBeNull();
  });

  it('returns null for any non-D subcommand', () => {
    expect(parseOsc133ExitCode('A')).toBeNull();
    expect(parseOsc133ExitCode('B')).toBeNull();
    expect(parseOsc133ExitCode('C')).toBeNull();
    expect(parseOsc133ExitCode('E;command-line')).toBeNull();
  });

  it('returns null for malformed payloads (missing separator)', () => {
    expect(parseOsc133ExitCode('D0')).toBeNull();
  });
});

describe('exitCodeGutterClass (HS-7267)', () => {
  it('maps exit 0 → success (green check)', () => {
    expect(exitCodeGutterClass(0)).toBe('success');
  });
  it('maps non-zero exit → failure (red x)', () => {
    expect(exitCodeGutterClass(1)).toBe('failure');
    expect(exitCodeGutterClass(137)).toBe('failure');
    expect(exitCodeGutterClass(-1)).toBe('failure');
  });
  it('maps null (no exit code reported) → neutral (grey dot)', () => {
    expect(exitCodeGutterClass(null)).toBe('neutral');
  });
});

describe('computeLastOutputRange (HS-7268)', () => {
  const alive = (line: number) => ({ line, isDisposed: false });
  const disposed = (line: number) => ({ line, isDisposed: true });

  it('returns null when there are no records at all', () => {
    expect(computeLastOutputRange({ current: null, commands: [], cursorLine: 10 })).toBeNull();
  });

  it('returns null when the only record has no C marker (shell emits only A/D)', () => {
    const record = { outputStart: null, commandEnd: alive(20) };
    expect(computeLastOutputRange({ current: null, commands: [record], cursorLine: 20 })).toBeNull();
  });

  it('returns null when the C marker has been disposed (scrollback trimmed)', () => {
    const record = { outputStart: disposed(5), commandEnd: alive(20) };
    expect(computeLastOutputRange({ current: null, commands: [record], cursorLine: 20 })).toBeNull();
  });

  it('returns [C, D) for a completed record with both markers alive', () => {
    const record = { outputStart: alive(10), commandEnd: alive(15) };
    expect(computeLastOutputRange({ current: null, commands: [record], cursorLine: 15 }))
      .toEqual({ start: 10, end: 15 });
  });

  it('falls back to cursorLine+1 when D has been disposed but C is alive', () => {
    const record = { outputStart: alive(10), commandEnd: disposed(15) };
    expect(computeLastOutputRange({ current: null, commands: [record], cursorLine: 20 }))
      .toEqual({ start: 10, end: 21 });
  });

  it('prefers the in-flight record (running command) over the latest completed one', () => {
    const completed = { outputStart: alive(5), commandEnd: alive(8) };
    const running = { outputStart: alive(12) };
    expect(computeLastOutputRange({ current: running, commands: [completed], cursorLine: 14 }))
      .toEqual({ start: 12, end: 15 });
  });

  it('returns null for an in-flight record whose C marker was disposed', () => {
    const completed = { outputStart: alive(5), commandEnd: alive(8) };
    const running = { outputStart: disposed(12) };
    // Still falls back to the completed record (which is alive) — null happens
    // only when neither path is available.
    expect(computeLastOutputRange({ current: running, commands: [completed], cursorLine: 14 }))
      .toEqual({ start: 5, end: 8 });
  });

  it('returns null for an in-flight record with no C (B seen but C not yet)', () => {
    const running = { outputStart: null };
    expect(computeLastOutputRange({ current: running, commands: [], cursorLine: 14 })).toBeNull();
  });

  it('uses only the latest completed record when multiple exist', () => {
    const older = { outputStart: alive(0), commandEnd: alive(2) };
    const latest = { outputStart: alive(10), commandEnd: alive(15) };
    expect(computeLastOutputRange({ current: null, commands: [older, latest], cursorLine: 20 }))
      .toEqual({ start: 10, end: 15 });
  });

  it('returns null when the computed range is empty (D on same line as C)', () => {
    const record = { outputStart: alive(10), commandEnd: alive(10) };
    expect(computeLastOutputRange({ current: null, commands: [record], cursorLine: 10 })).toBeNull();
  });

  it('returns null when the computed range is inverted (D before C)', () => {
    const record = { outputStart: alive(10), commandEnd: alive(5) };
    expect(computeLastOutputRange({ current: null, commands: [record], cursorLine: 10 })).toBeNull();
  });

  it('returns [C, cursor+1) for a running command on its first output line', () => {
    const running = { outputStart: alive(42) };
    expect(computeLastOutputRange({ current: running, commands: [], cursorLine: 42 }))
      .toEqual({ start: 42, end: 43 });
  });
});

describe('findPromptLine (HS-7269)', () => {
  it('returns null for an empty list', () => {
    expect(findPromptLine({ promptLines: [], fromLine: 50, direction: 'prev' })).toBeNull();
    expect(findPromptLine({ promptLines: [], fromLine: 50, direction: 'next' })).toBeNull();
  });

  it('prev — returns the newest line strictly below fromLine', () => {
    expect(findPromptLine({ promptLines: [10, 20, 30], fromLine: 25, direction: 'prev' })).toBe(20);
  });

  it('prev — skips markers at or above fromLine', () => {
    expect(findPromptLine({ promptLines: [10, 25, 30], fromLine: 25, direction: 'prev' })).toBe(10);
  });

  it('prev — returns null when all markers are at or above fromLine', () => {
    expect(findPromptLine({ promptLines: [30, 40], fromLine: 25, direction: 'prev' })).toBeNull();
  });

  it('next — returns the oldest line strictly above fromLine', () => {
    expect(findPromptLine({ promptLines: [10, 20, 30], fromLine: 15, direction: 'next' })).toBe(20);
  });

  it('next — skips markers at or below fromLine', () => {
    expect(findPromptLine({ promptLines: [10, 20, 30], fromLine: 20, direction: 'next' })).toBe(30);
  });

  it('next — returns null when all markers are at or below fromLine', () => {
    expect(findPromptLine({ promptLines: [10, 20], fromLine: 25, direction: 'next' })).toBeNull();
  });

  it('handles out-of-order input (line sort is not assumed)', () => {
    expect(findPromptLine({ promptLines: [50, 10, 30, 20], fromLine: 25, direction: 'prev' })).toBe(20);
    expect(findPromptLine({ promptLines: [50, 10, 30, 20], fromLine: 25, direction: 'next' })).toBe(30);
  });

  it('handles a single marker', () => {
    expect(findPromptLine({ promptLines: [10], fromLine: 5, direction: 'next' })).toBe(10);
    expect(findPromptLine({ promptLines: [10], fromLine: 10, direction: 'next' })).toBeNull();
    expect(findPromptLine({ promptLines: [10], fromLine: 15, direction: 'prev' })).toBe(10);
    expect(findPromptLine({ promptLines: [10], fromLine: 10, direction: 'prev' })).toBeNull();
  });
});

describe('buildAskClaudePrompt (HS-7270)', () => {
  it('produces the full template with cwd, exit code, and output', () => {
    const prompt = buildAskClaudePrompt({
      command: 'npm run build',
      exitCode: 2,
      cwd: '/Users/me/project',
      output: 'error: missing dep',
    });
    expect(prompt).toContain('The command `npm run build` exited with code 2 in `/Users/me/project`.');
    expect(prompt).toContain('```\nerror: missing dep\n```');
    expect(prompt).toMatch(/Please diagnose and propose a fix\.$/);
  });

  it('omits the cwd clause when cwd is null', () => {
    const prompt = buildAskClaudePrompt({
      command: 'ls',
      exitCode: 1,
      cwd: null,
      output: 'boom',
    });
    expect(prompt).toContain('`ls` exited with code 1. Output:');
    expect(prompt).not.toContain(' in ``');
    expect(prompt).not.toContain(' in `');
  });

  it('omits the cwd clause when cwd is empty string', () => {
    const prompt = buildAskClaudePrompt({
      command: 'ls',
      exitCode: 1,
      cwd: '',
      output: 'boom',
    });
    expect(prompt).not.toContain(' in ``');
  });

  it('handles a null exit code as "(no exit code reported)"', () => {
    const prompt = buildAskClaudePrompt({
      command: 'foo',
      exitCode: null,
      cwd: '/tmp',
      output: 'x',
    });
    expect(prompt).toContain('`foo` exited (no exit code reported) in `/tmp`.');
  });

  it('replaces empty output with a "(no output captured)" placeholder', () => {
    const prompt = buildAskClaudePrompt({
      command: 'true',
      exitCode: 0,
      cwd: null,
      output: '',
    });
    expect(prompt).toContain('*(no output captured)*');
    expect(prompt).not.toContain('```');
  });

  it('truncates output to the LAST maxOutputChars characters with a header', () => {
    const longOutput = 'A'.repeat(100) + 'TAIL';
    const prompt = buildAskClaudePrompt({
      command: 'spam',
      exitCode: 1,
      cwd: null,
      output: longOutput,
      maxOutputChars: 10,
    });
    expect(prompt).toContain('[output truncated to last 10 chars]');
    // Must include the last 10 chars (which end with TAIL) and NOT the leading As.
    expect(prompt).toContain('AAAAAATAIL');
    expect(prompt).not.toContain('A'.repeat(20));
  });

  it('does not truncate when output is exactly at the cap', () => {
    const output = 'B'.repeat(10);
    const prompt = buildAskClaudePrompt({
      command: 'ok',
      exitCode: 0,
      cwd: null,
      output,
      maxOutputChars: 10,
    });
    expect(prompt).not.toContain('truncated');
    expect(prompt).toContain('```\nBBBBBBBBBB\n```');
  });

  it('defaults maxOutputChars to 8000 and uses it to truncate huge output', () => {
    const output = 'X'.repeat(9000) + 'END';
    const prompt = buildAskClaudePrompt({
      command: 'big',
      exitCode: 137,
      cwd: null,
      output,
    });
    expect(prompt).toContain('[output truncated to last 8000 chars]');
    expect(prompt).toContain('END');
  });

  it('includes exit code 0 for successful commands (user asking "why did this succeed" is valid)', () => {
    const prompt = buildAskClaudePrompt({
      command: 'echo ok',
      exitCode: 0,
      cwd: null,
      output: 'ok',
    });
    expect(prompt).toContain('exited with code 0');
  });
});
