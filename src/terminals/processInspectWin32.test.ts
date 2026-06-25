/**
 * HS-9027 — Windows adapter for terminal process inspection.
 *
 * These tests are deliberately PURE: they exercise `parseWin32ProcessOutput`
 * + the platform-agnostic `descendantChain` / `pickForegroundProcess` over
 * CAPTURED `Get-CimInstance Win32_Process` sample output. No process is
 * spawned and `process.kill` is never called, so the suite is safe to run on
 * any host (macOS / Linux / Windows) — mirroring the `build_tts_command`
 * platform-parameterized pattern.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXEMPT_PROCESSES,
  descendantChain,
  parseWin32ProcessOutput,
  pickForegroundProcess,
  WIN32_PROCESS_ARGS,
  WIN32_PROCESS_EXE,
} from './processInspect.js';

// Captured-style `Get-CimInstance Win32_Process` projection:
// `ProcessId<TAB>ParentProcessId<TAB>Name`, one line per process, no header.
const SAMPLE = [
  '0\t0\tSystem Idle Process',
  '4\t0\tSystem',
  '700\t4\tsmss.exe',
  '1000\t700\tcsrss.exe',
  '2500\t1\tconhost.exe',
  '3000\t1\tcmd.exe',          // a PTY's shell
  '3500\t3000\tnode.exe',      // real work under the shell
  '9000\t1\tpowershell.exe',   // a second, IDLE shell (no children)
].join('\n');

describe('parseWin32ProcessOutput (HS-9027)', () => {
  it('parses pid / ppid / normalized name and strips the .exe suffix', () => {
    const rows = parseWin32ProcessOutput(SAMPLE);
    const cmd = rows.find(r => r.pid === 3000);
    expect(cmd).toEqual({ pid: 3000, ppid: 1, comm: 'cmd' });
    const node = rows.find(r => r.pid === 3500);
    expect(node).toEqual({ pid: 3500, ppid: 3000, comm: 'node' });
    // Names with spaces survive (System Idle Process), .exe stripped on the rest.
    expect(rows.find(r => r.pid === 0)?.comm).toBe('System Idle Process');
    expect(rows.find(r => r.pid === 9000)?.comm).toBe('powershell');
  });

  it('tolerates CRLF line endings', () => {
    const rows = parseWin32ProcessOutput('3000\t1\tcmd.exe\r\n3500\t3000\tnode.exe\r\n');
    expect(rows).toEqual([
      { pid: 3000, ppid: 1, comm: 'cmd' },
      { pid: 3500, ppid: 3000, comm: 'node' },
    ]);
  });

  it('skips blank + malformed lines (missing columns / non-numeric ids)', () => {
    const rows = parseWin32ProcessOutput([
      '',
      '   ',
      'garbage line with no tabs',
      'NaN\t1\tfoo.exe',
      '12\t\tbar.exe',          // empty ppid → NaN → skipped
      '42\t1\tgood.exe',
    ].join('\n'));
    expect(rows).toEqual([{ pid: 42, ppid: 1, comm: 'good' }]);
  });

  it('returns an empty list for empty input', () => {
    expect(parseWin32ProcessOutput('')).toEqual([]);
  });
});

describe('Windows foreground selection end-to-end (HS-9027)', () => {
  it('flags a shell running real work (cmd → node) as a non-exempt foreground', () => {
    const rows = parseWin32ProcessOutput(SAMPLE);
    const chain = descendantChain(rows, 3000); // PTY rooted at cmd.exe
    expect(chain).toEqual(['cmd', 'node']);
    const info = pickForegroundProcess(chain, DEFAULT_EXEMPT_PROCESSES);
    expect(info).toEqual({ command: 'node', isShell: false, isExempt: false, error: null });
  });

  it('treats an idle login shell (powershell.exe, no children) as exempt', () => {
    const rows = parseWin32ProcessOutput(SAMPLE);
    const chain = descendantChain(rows, 9000);
    expect(chain).toEqual(['powershell']);
    const info = pickForegroundProcess(chain, DEFAULT_EXEMPT_PROCESSES);
    expect(info).toEqual({ command: 'powershell', isShell: true, isExempt: true, error: null });
  });

  it('safe-default-prompts when the PTY root is not in the table', () => {
    const rows = parseWin32ProcessOutput(SAMPLE);
    const info = pickForegroundProcess(descendantChain(rows, 999999), DEFAULT_EXEMPT_PROCESSES);
    expect(info.command).toBe('?');
    expect(info.isExempt).toBe(false);
  });
});

describe('Windows enumeration command (HS-9027)', () => {
  it('invokes powershell.exe with a non-interactive, profile-free CIM query', () => {
    expect(WIN32_PROCESS_EXE).toBe('powershell.exe');
    expect(WIN32_PROCESS_ARGS).toContain('-NoProfile');
    expect(WIN32_PROCESS_ARGS).toContain('-NonInteractive');
    const script = WIN32_PROCESS_ARGS[WIN32_PROCESS_ARGS.length - 1];
    expect(script).toContain('Get-CimInstance Win32_Process');
    expect(script).toContain('ProcessId');
    expect(script).toContain('ParentProcessId');
  });
});
