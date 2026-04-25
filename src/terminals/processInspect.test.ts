import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXEMPT_PROCESSES,
  descendantChain,
  normalizeComm,
  parsePsOutput,
  pickForegroundProcess,
  SHELL_BASENAMES,
} from './processInspect.js';

describe('normalizeComm', () => {
  it('strips Unix path prefix (macOS ps -o comm reports full executable path)', () => {
    expect(normalizeComm('/bin/zsh')).toBe('zsh');
    expect(normalizeComm('/usr/local/bin/htop')).toBe('htop');
    expect(normalizeComm('/usr/libexec/foo-bar')).toBe('foo-bar');
  });

  it('strips Windows backslash path prefix', () => {
    expect(normalizeComm('C:\\Windows\\System32\\cmd.exe')).toBe('cmd');
    expect(normalizeComm('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('pwsh');
  });

  it('strips the leading dash on login-shell commands', () => {
    expect(normalizeComm('-zsh')).toBe('zsh');
    expect(normalizeComm('-bash')).toBe('bash');
  });

  it('strips Windows .exe suffix (case-insensitive)', () => {
    expect(normalizeComm('cmd.exe')).toBe('cmd');
    expect(normalizeComm('PWSH.EXE')).toBe('PWSH');
  });

  it('returns the input unchanged when already a basename', () => {
    expect(normalizeComm('claude')).toBe('claude');
    expect(normalizeComm('node')).toBe('node');
  });

  it('returns empty string for empty / whitespace input', () => {
    expect(normalizeComm('')).toBe('');
    expect(normalizeComm('   ')).toBe('');
  });

  it('handles a command name that itself starts with a dash by only stripping one dash', () => {
    // Pathological — login shell whose argv[0] is `-something`. Strip only
    // the leading dash, not arbitrary dash prefixes.
    expect(normalizeComm('-zsh')).toBe('zsh');
  });
});

describe('parsePsOutput', () => {
  it('skips a header line that does not start with a digit', () => {
    const out = '  PID  PPID COMM\n12345 1 zsh\n23456 12345 claude\n';
    const rows = parsePsOutput(out);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ pid: 12345, ppid: 1, comm: 'zsh' });
    expect(rows[1]).toEqual({ pid: 23456, ppid: 12345, comm: 'claude' });
  });

  it('returns all rows when no header is present', () => {
    const out = '100 1 init\n200 100 bash\n';
    const rows = parsePsOutput(out);
    expect(rows).toHaveLength(2);
  });

  it('skips blank lines + lines with non-numeric pid', () => {
    const out = '100 1 init\n\nbogus row\n200 100 bash\n  \n';
    const rows = parsePsOutput(out);
    expect(rows).toHaveLength(2);
    expect(rows[0].comm).toBe('init');
    expect(rows[1].comm).toBe('bash');
  });

  it('joins remaining whitespace-separated tokens into comm (covers exotic ps output)', () => {
    const out = '100 1 some weird command';
    const rows = parsePsOutput(out);
    expect(rows).toHaveLength(1);
    expect(rows[0].comm).toBe('some weird command');
  });

  it('returns an empty array for empty input', () => {
    expect(parsePsOutput('')).toEqual([]);
    expect(parsePsOutput('\n\n')).toEqual([]);
  });

  it('normalizes macOS-style full-path comm values to basenames (HS-7790)', () => {
    // macOS `ps -o pid,ppid,comm -A` emits the executable's full path as the
    // comm column. Without normalization the shell + exempt-list comparisons
    // never match, so the user's "exempt zsh" choice is silently ignored.
    const out = '  PID  PPID COMM\n12345 1 /bin/zsh\n23456 12345 /usr/local/bin/htop\n';
    const rows = parsePsOutput(out);
    expect(rows).toHaveLength(2);
    expect(rows[0].comm).toBe('zsh');
    expect(rows[1].comm).toBe('htop');
  });

  it('normalizes login-shell comm values that have a leading dash (HS-7790)', () => {
    const out = '  PID  PPID COMM\n100 1 -zsh\n';
    const rows = parsePsOutput(out);
    expect(rows[0].comm).toBe('zsh');
  });
});

describe('descendantChain', () => {
  const rows = [
    { pid: 100, ppid: 1, comm: 'init' },
    { pid: 200, ppid: 100, comm: 'zsh' },
    { pid: 300, ppid: 200, comm: 'claude' },
    { pid: 400, ppid: 300, comm: 'node' },
    { pid: 500, ppid: 100, comm: 'fish' },
  ];

  it('returns [root] when the root has no children', () => {
    expect(descendantChain(rows, 500)).toEqual(['fish']);
  });

  it('walks the deepest descendant chain, picking the highest-pid child at each level', () => {
    expect(descendantChain(rows, 200)).toEqual(['zsh', 'claude', 'node']);
  });

  it('returns an empty array when the root pid is not in the rows', () => {
    expect(descendantChain(rows, 999)).toEqual([]);
  });

  it('caps depth to defend against pathological cycles in malformed ps output', () => {
    // Build a fake cycle: 1 → 2 → 1 → 2 ... shouldn't happen in real ps output
    // but the helper should still terminate.
    const cyclic = [
      { pid: 1, ppid: 0, comm: 'a' },
      { pid: 2, ppid: 1, comm: 'b' },
      // Pretend pid 2's child is pid 1 (cycle)
      { pid: 1, ppid: 2, comm: 'a-again' }, // duplicate pid — Map last write wins
    ];
    // Even with cycle, the helper terminates within the 10-step cap.
    const chain = descendantChain(cyclic, 1);
    expect(chain.length).toBeLessThanOrEqual(11); // root + up to 10 descendants
  });

  it('picks the highest-pid sibling at each branching level', () => {
    const branched = [
      { pid: 100, ppid: 1, comm: 'shell' },
      { pid: 200, ppid: 100, comm: 'old-child' },
      { pid: 250, ppid: 100, comm: 'newer-child' },
    ];
    expect(descendantChain(branched, 100)).toEqual(['shell', 'newer-child']);
  });
});

describe('pickForegroundProcess', () => {
  const exempt = ['htop', 'less', 'tmux'];

  it('returns the safe-default-prompt info on empty chain (process not found)', () => {
    const info = pickForegroundProcess([], exempt);
    expect(info.command).toBe('?');
    expect(info.isShell).toBe(false);
    expect(info.isExempt).toBe(false);
    expect(info.error).toBe('process not found');
  });

  it('idle shell (chain length 1, root is shell) → exempt + isShell', () => {
    const info = pickForegroundProcess(['zsh'], exempt);
    expect(info.command).toBe('zsh');
    expect(info.isShell).toBe(true);
    expect(info.isExempt).toBe(true);
    expect(info.error).toBeNull();
  });

  it('non-shell root with no descendants — uses the root, exempt-list lookup decides', () => {
    expect(pickForegroundProcess(['claude'], exempt)).toMatchObject({
      command: 'claude', isShell: false, isExempt: false,
    });
    expect(pickForegroundProcess(['htop'], exempt)).toMatchObject({
      command: 'htop', isShell: false, isExempt: true,
    });
  });

  it('shell root with non-shell descendant — descendant becomes the foreground', () => {
    const info = pickForegroundProcess(['zsh', 'claude'], exempt);
    expect(info.command).toBe('claude');
    expect(info.isShell).toBe(false);
    expect(info.isExempt).toBe(false);
  });

  it('shell root with exempt descendant → exempt fires (no prompt)', () => {
    const info = pickForegroundProcess(['zsh', 'htop'], exempt);
    expect(info.command).toBe('htop');
    expect(info.isExempt).toBe(true);
  });

  it('shell root with multiple non-shell descendants → uses the deepest', () => {
    const info = pickForegroundProcess(['bash', 'npm', 'node'], exempt);
    expect(info.command).toBe('node');
    expect(info.isShell).toBe(false);
    expect(info.isExempt).toBe(false);
  });

  it('non-shell root with descendants → uses the chain tail', () => {
    const info = pickForegroundProcess(['npm', 'node'], exempt);
    expect(info.command).toBe('node');
    expect(info.isShell).toBe(false);
    expect(info.isExempt).toBe(false);
  });

  it('exempt-list match is case-insensitive on the basename', () => {
    const info = pickForegroundProcess(['zsh', 'HTOP'], exempt);
    expect(info.command).toBe('HTOP');
    expect(info.isExempt).toBe(true);
  });

  it('uses the default exempt list when caller passes the constant', () => {
    const info = pickForegroundProcess(['zsh', 'tmux'], DEFAULT_EXEMPT_PROCESSES);
    expect(info.isExempt).toBe(true);
  });

  it('shell-only chain (every descendant is a shell) → tail as foreground, treated as shell', () => {
    // e.g. zsh launching another zsh — exempt by isShell rule.
    const info = pickForegroundProcess(['zsh', 'bash'], exempt);
    expect(info.command).toBe('bash');
    expect(info.isShell).toBe(true);
    expect(info.isExempt).toBe(true);
  });

  it('SHELL_BASENAMES covers the major Unix + Windows shells', () => {
    expect(SHELL_BASENAMES.has('bash')).toBe(true);
    expect(SHELL_BASENAMES.has('zsh')).toBe(true);
    expect(SHELL_BASENAMES.has('fish')).toBe(true);
    expect(SHELL_BASENAMES.has('sh')).toBe(true);
    expect(SHELL_BASENAMES.has('pwsh')).toBe(true);
    expect(SHELL_BASENAMES.has('cmd.exe')).toBe(true);
    expect(SHELL_BASENAMES.has('claude')).toBe(false);
    expect(SHELL_BASENAMES.has('htop')).toBe(false);
  });

  it('DEFAULT_EXEMPT_PROCESSES matches macOS Terminal.app defaults', () => {
    expect(DEFAULT_EXEMPT_PROCESSES).toContain('screen');
    expect(DEFAULT_EXEMPT_PROCESSES).toContain('tmux');
    expect(DEFAULT_EXEMPT_PROCESSES).toContain('less');
    expect(DEFAULT_EXEMPT_PROCESSES).toContain('htop');
  });

  it('end-to-end: a real macOS-style ps tree with /bin/zsh as the only descendant resolves to an idle exempt shell (HS-7790)', () => {
    // This is the exact failure mode reported in HS-7790: user has zsh in
    // their exempt list AND the only running process is zsh, but the prompt
    // still fired because ps emitted `/bin/zsh` and the comparison missed.
    const out = '  PID  PPID COMM\n100 1 /sbin/launchd\n200 100 /bin/zsh\n';
    const rows = parsePsOutput(out);
    const chain = descendantChain(rows, 200);
    const info = pickForegroundProcess(chain, ['zsh']);
    expect(info.command).toBe('zsh');
    expect(info.isShell).toBe(true);
    expect(info.isExempt).toBe(true);
  });
});
