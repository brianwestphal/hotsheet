import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  attach,
  clearBellPending,
  destroyAllTerminals,
  destroyTerminal,
  detach,
  ensureSpawned,
  getBellPending,
  getTerminalStatus,
  killTerminal,
  listBellPendingForProject,
  type PtyFactory,
  type PtyLike,
  resizeTerminal,
  restartTerminal,
  setPtyFactory,
  type SpawnArgs,
  writeInput,
} from './registry.js';

/** Minimal in-memory PTY that records writes, emits data on demand, and supports exit. */
class FakePty implements PtyLike {
  static lastSpawned: FakePty | null = null;
  pid = 0;
  cols: number;
  rows: number;
  command: string;
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  killed = false;
  killSignals: string[] = [];

  private dataListeners = new Set<(s: string) => void>();
  private exitListeners = new Set<(e: { exitCode: number; signal?: number }) => void>();

  constructor(args: SpawnArgs) {
    this.cols = args.cols;
    this.rows = args.rows;
    this.command = args.command;
    this.pid = Math.floor(Math.random() * 1_000_000);
    FakePty.lastSpawned = this;
  }

  onData(listener: (s: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => { this.dataListeners.delete(listener); } };
  }

  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitListeners.add(listener);
    return { dispose: () => { this.exitListeners.delete(listener); } };
  }

  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.resizes.push([cols, rows]);
  }
  kill(signal?: string): void {
    this.killSignals.push(signal ?? '');
    if (this.killed) return;
    this.killed = true;
    // Don't auto-emit exit — tests that want exit should call emitExit.
  }

  emit(data: string): void {
    for (const l of this.dataListeners) l(data);
  }
  emitExit(exitCode: number): void {
    for (const l of this.exitListeners) l({ exitCode });
  }
}

const factory: PtyFactory = (args) => new FakePty(args);

function makeDataDir(settings: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'hs-term-'));
  const dataDir = join(root, '.hotsheet');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings));
  return dataDir;
}

describe('TerminalRegistry', () => {
  const cleanup: string[] = [];
  let restore: PtyFactory | undefined;

  beforeEach(() => {
    restore = setPtyFactory(factory);
    cleanup.length = 0;
  });
  afterEach(() => {
    destroyAllTerminals();
    if (restore !== undefined) setPtyFactory(restore);
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
    FakePty.lastSpawned = null;
  });

  function tmpDataDir(settings: Record<string, unknown> = {}): string {
    const d = makeDataDir({ terminal_command: '/bin/sh', ...settings });
    cleanup.push(d);
    return d;
  }

  function makeSub() {
    const received: Buffer[] = [];
    let exitCode: number | null = null;
    const sub = {
      onData(chunk: Buffer) { received.push(chunk); },
      onExit(code: number) { exitCode = code; },
    };
    return { sub, received, getExitCode: () => exitCode };
  }

  it('lazily spawns on first attach', () => {
    expect(FakePty.lastSpawned).toBeNull();
    const { sub } = makeSub();
    const result = attach('secret-1', tmpDataDir(), sub);
    expect(FakePty.lastSpawned).not.toBeNull();
    expect(result.alive).toBe(true);
    expect(result.history.length).toBe(0);
  });

  it('reuses the same PTY across re-attaches from the same project', () => {
    const dir = tmpDataDir();
    const { sub: a } = makeSub();
    const { sub: b } = makeSub();
    attach('secret-1', dir, a);
    const pty1 = FakePty.lastSpawned;
    attach('secret-1', dir, b);
    const pty2 = FakePty.lastSpawned;
    expect(pty1).toBe(pty2);
  });

  it('broadcasts PTY output to every attached subscriber and records scrollback', () => {
    const dir = tmpDataDir();
    const { sub: a, received: aReceived } = makeSub();
    const { sub: b, received: bReceived } = makeSub();
    attach('secret-1', dir, a);
    attach('secret-1', dir, b);
    FakePty.lastSpawned!.emit('hello');
    FakePty.lastSpawned!.emit(' world');
    expect(Buffer.concat(aReceived).toString()).toBe('hello world');
    expect(Buffer.concat(bReceived).toString()).toBe('hello world');
    const status = getTerminalStatus('secret-1', dir);
    expect(status.scrollbackBytes).toBe(11);
  });

  it('replays scrollback to late subscribers on attach', () => {
    const dir = tmpDataDir();
    const { sub: early } = makeSub();
    attach('secret-1', dir, early);
    FakePty.lastSpawned!.emit('past output');

    const { sub: late } = makeSub();
    const result = attach('secret-1', dir, late);
    expect(result.history.toString()).toBe('past output');
  });

  it('detach stops further broadcasts to that subscriber', () => {
    const dir = tmpDataDir();
    const { sub: a, received: aReceived } = makeSub();
    const { sub: b, received: bReceived } = makeSub();
    attach('secret-1', dir, a);
    attach('secret-1', dir, b);
    detach('secret-1', a);
    FakePty.lastSpawned!.emit('after-detach');
    expect(Buffer.concat(aReceived).toString()).toBe('');
    expect(Buffer.concat(bReceived).toString()).toBe('after-detach');
  });

  it('writeInput forwards to the PTY', () => {
    const dir = tmpDataDir();
    const { sub } = makeSub();
    attach('secret-1', dir, sub);
    writeInput('secret-1', 'ls\n');
    writeInput('secret-1', 'exit\n');
    expect(FakePty.lastSpawned!.writes).toEqual(['ls\n', 'exit\n']);
  });

  it('resizeTerminal forwards to the PTY and updates cached dims', () => {
    const dir = tmpDataDir();
    const { sub } = makeSub();
    attach('secret-1', dir, sub);
    resizeTerminal('secret-1', 120, 40);
    expect(FakePty.lastSpawned!.resizes).toEqual([[120, 40]]);
    expect(getTerminalStatus('secret-1', dir).cols).toBe(120);
    expect(getTerminalStatus('secret-1', dir).rows).toBe(40);
  });

  it('transitions to `exited` state when the process exits and notifies subscribers', () => {
    const dir = tmpDataDir();
    const { sub, getExitCode } = makeSub();
    attach('secret-1', dir, sub);
    FakePty.lastSpawned!.emitExit(42);
    expect(getExitCode()).toBe(42);
    const status = getTerminalStatus('secret-1', dir);
    expect(status.state).toBe('exited');
    expect(status.exitCode).toBe(42);
  });

  it('does NOT auto-respawn when attaching to an exited session', () => {
    const dir = tmpDataDir();
    const { sub } = makeSub();
    attach('secret-1', dir, sub);
    const firstPty = FakePty.lastSpawned;
    FakePty.lastSpawned!.emitExit(0);

    const { sub: sub2 } = makeSub();
    const result = attach('secret-1', dir, sub2);
    expect(result.alive).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(FakePty.lastSpawned).toBe(firstPty); // no new spawn
  });

  it('restartTerminal kills the old PTY, clears scrollback, and spawns a fresh one', () => {
    const dir = tmpDataDir();
    const { sub, received } = makeSub();
    attach('secret-1', dir, sub);
    const oldPty = FakePty.lastSpawned!;
    oldPty.emit('old-output');
    expect(getTerminalStatus('secret-1', dir).scrollbackBytes).toBe(10);

    restartTerminal('secret-1', dir);
    const newPty = FakePty.lastSpawned!;
    expect(newPty).not.toBe(oldPty);
    expect(oldPty.killed).toBe(true);

    // Scrollback cleared after restart
    expect(getTerminalStatus('secret-1', dir).scrollbackBytes).toBe(0);

    // Old PTY's async exit should NOT reach subscribers (listeners were disposed)
    const receivedLengthBeforeExit = received.length;
    oldPty.emitExit(130);
    expect(received.length).toBe(receivedLengthBeforeExit);
    // ...but subscribers are still attached and receive the new PTY's output.
    newPty.emit('fresh');
    const newChunksOnly = received.slice(receivedLengthBeforeExit);
    expect(Buffer.concat(newChunksOnly).toString()).toBe('fresh');
  });

  it('killTerminal delivers exit to subscribers (unlike restart)', () => {
    const dir = tmpDataDir();
    const { sub, getExitCode } = makeSub();
    attach('secret-1', dir, sub);
    killTerminal('secret-1');
    // The fake kill doesn't auto-emit exit; a real pty would.
    // Here we simulate that the OS-level kill triggers the onExit listener.
    FakePty.lastSpawned!.emitExit(143);
    expect(getExitCode()).toBe(143);
  });

  it('destroyTerminal removes the session so the next attach spawns fresh', () => {
    const dir = tmpDataDir();
    const { sub } = makeSub();
    attach('secret-1', dir, sub);
    const firstPty = FakePty.lastSpawned;
    destroyTerminal('secret-1');

    const { sub: sub2 } = makeSub();
    attach('secret-1', dir, sub2);
    expect(FakePty.lastSpawned).not.toBe(firstPty);
    expect(firstPty!.killed).toBe(true);
  });

  it('scrollback ring buffer honors terminal_scrollback_bytes setting (clamped to min)', () => {
    // Ask for 500 bytes — below the 65_536 minimum. Registry should clamp up.
    const dir = tmpDataDir({ terminal_scrollback_bytes: '500' });
    const { sub } = makeSub();
    attach('secret-1', dir, sub);
    // Emit 64 KiB + 1 — should all fit because minimum is 64 KiB.
    FakePty.lastSpawned!.emit('x'.repeat(65_537));
    expect(getTerminalStatus('secret-1', dir).scrollbackBytes).toBe(65_536);
  });

  it('isolates sessions across different project secrets', () => {
    const dirA = tmpDataDir();
    const dirB = tmpDataDir();
    const { sub: a, received: aReceived } = makeSub();
    const { sub: b, received: bReceived } = makeSub();
    attach('secret-A', dirA, a);
    attach('secret-B', dirB, b);
    // Two distinct PTYs
    // Fire data on the most recently spawned (B); A should not see it.
    const ptyB = FakePty.lastSpawned!;
    ptyB.emit('for-B');
    expect(Buffer.concat(bReceived).toString()).toBe('for-B');
    expect(Buffer.concat(aReceived).toString()).toBe('');
  });

  it('status reports not_spawned for an unknown secret', () => {
    const status = getTerminalStatus('never-seen', tmpDataDir());
    expect(status.state).toBe('not_spawned');
    expect(status.scrollbackBytes).toBeGreaterThan(0); // default buffer size
  });

  it('keeps distinct PTYs for different terminalIds under the same secret (HS-6306/HS-6271)', () => {
    const d = tmpDataDir();
    const { sub: subA, received: aReceived } = makeSub();
    const { sub: subB, received: bReceived } = makeSub();

    attach('secret-multi', d, subA, {
      configOverride: { id: 'alpha', command: '/bin/echo alpha' },
    }, 'alpha');
    const ptyAlpha = FakePty.lastSpawned!;

    attach('secret-multi', d, subB, {
      configOverride: { id: 'beta', command: '/bin/echo beta' },
    }, 'beta');
    const ptyBeta = FakePty.lastSpawned!;

    expect(ptyAlpha).not.toBe(ptyBeta);
    ptyAlpha.emit('from-alpha');
    ptyBeta.emit('from-beta');
    expect(Buffer.concat(aReceived).toString()).toBe('from-alpha');
    expect(Buffer.concat(bReceived).toString()).toBe('from-beta');
  });

  it('ensureSpawned creates and spawns a session without any subscriber (HS-6310)', () => {
    const d = tmpDataDir();
    expect(FakePty.lastSpawned).toBeNull();
    ensureSpawned('secret-eager', d, 'main');
    expect(FakePty.lastSpawned).not.toBeNull();
    const status = getTerminalStatus('secret-eager', d, 'main');
    expect(status.state).toBe('alive');
  });

  it('ensureSpawned is idempotent — repeat calls do not respawn a live session', () => {
    const d = tmpDataDir();
    ensureSpawned('secret-idem', d, 'main');
    const first = FakePty.lastSpawned;
    ensureSpawned('secret-idem', d, 'main');
    expect(FakePty.lastSpawned).toBe(first);
  });

  it('ensureSpawned does NOT resurrect an exited session', () => {
    const d = tmpDataDir();
    ensureSpawned('secret-exit', d, 'main');
    FakePty.lastSpawned!.emitExit(0);
    const ptyAtExit = FakePty.lastSpawned;
    ensureSpawned('secret-exit', d, 'main');
    expect(FakePty.lastSpawned).toBe(ptyAtExit);
    expect(getTerminalStatus('secret-exit', d, 'main').state).toBe('exited');
  });

  // HS-6471: interactive shells ignore SIGTERM but exit on SIGHUP. The registry
  // must forward whatever signal the caller picked so the client's choice of
  // SIGHUP actually reaches the PTY.
  it('killTerminal forwards the requested signal to the PTY (HS-6471)', () => {
    const d = tmpDataDir();
    const { sub } = makeSub();
    attach('secret-sighup', d, sub);
    const pty = FakePty.lastSpawned!;
    killTerminal('secret-sighup', 'SIGHUP');
    expect(pty.killSignals).toEqual(['SIGHUP']);
  });

  it('killTerminal defaults to SIGTERM when no signal is provided', () => {
    const d = tmpDataDir();
    const { sub } = makeSub();
    attach('secret-default-kill', d, sub);
    const pty = FakePty.lastSpawned!;
    killTerminal('secret-default-kill');
    expect(pty.killSignals).toEqual(['SIGTERM']);
  });

  it('killTerminal accepts terminalId and targets the right session', () => {
    const d = tmpDataDir();
    const { sub: subA, getExitCode: aExit } = makeSub();
    const { sub: subB, getExitCode: bExit } = makeSub();

    attach('secret-kill', d, subA, {
      configOverride: { id: 'a', command: '/bin/sh' },
    }, 'a');
    const ptyA = FakePty.lastSpawned!;
    attach('secret-kill', d, subB, {
      configOverride: { id: 'b', command: '/bin/sh' },
    }, 'b');
    const ptyB = FakePty.lastSpawned!;

    killTerminal('secret-kill', 'SIGTERM', 'a');
    ptyA.emitExit(143);
    expect(aExit()).toBe(143);
    expect(bExit()).toBeNull();
    // ptyB should not be killed
    expect(ptyB.killed).toBe(false);
  });

  // HS-6603 §24.2 — server-side bell detection
  describe('bell detection (HS-6603)', () => {
    it('bellPending starts false and flips to true on a chunk containing 0x07', () => {
      const d = tmpDataDir();
      const { sub } = makeSub();
      attach('bell-sec', d, sub);
      expect(getBellPending('bell-sec')).toBe(false);
      FakePty.lastSpawned!.emit('hello\x07world');
      expect(getBellPending('bell-sec')).toBe(true);
    });

    it('subsequent bells on an already-pending session do not re-flip the flag', () => {
      const d = tmpDataDir();
      const { sub } = makeSub();
      attach('bell-sec-2', d, sub);
      FakePty.lastSpawned!.emit('\x07');
      expect(getBellPending('bell-sec-2')).toBe(true);
      // A second bell should not change state (still true, no flip).
      FakePty.lastSpawned!.emit('more\x07bells\x07here');
      expect(getBellPending('bell-sec-2')).toBe(true);
    });

    it('clearBellPending() flips the flag back to false and reports whether it flipped', () => {
      const d = tmpDataDir();
      const { sub } = makeSub();
      attach('bell-sec-3', d, sub);
      FakePty.lastSpawned!.emit('\x07');
      expect(clearBellPending('bell-sec-3')).toBe(true);
      expect(getBellPending('bell-sec-3')).toBe(false);
      // Clearing an already-clear terminal is a no-op.
      expect(clearBellPending('bell-sec-3')).toBe(false);
    });

    it('listBellPendingForProject returns only pending terminal ids for that project', () => {
      const d = tmpDataDir();
      const { sub: a } = makeSub();
      const { sub: b } = makeSub();
      const { sub: c } = makeSub();
      attach('bell-sec-4', d, a, { configOverride: { id: 'alpha', command: '/bin/sh' } }, 'alpha');
      const ptyAlpha = FakePty.lastSpawned!;
      attach('bell-sec-4', d, b, { configOverride: { id: 'beta', command: '/bin/sh' } }, 'beta');
      attach('bell-sec-4', d, c, { configOverride: { id: 'gamma', command: '/bin/sh' } }, 'gamma');
      const ptyGamma = FakePty.lastSpawned!;

      // Only alpha and gamma get bells.
      ptyAlpha.emit('\x07');
      ptyGamma.emit('hello\x07');

      const pending = listBellPendingForProject('bell-sec-4').map(e => e.terminalId).sort();
      expect(pending).toEqual(['alpha', 'gamma']);
    });

    it('listBellPendingForProject ignores other projects', () => {
      const d = tmpDataDir();
      const { sub: a } = makeSub();
      const { sub: b } = makeSub();
      attach('proj-a', d, a);
      const ptyA = FakePty.lastSpawned!;
      attach('proj-b', d, b);
      ptyA.emit('\x07');
      expect(listBellPendingForProject('proj-a').map(e => e.terminalId)).toEqual(['default']);
      expect(listBellPendingForProject('proj-b')).toEqual([]);
    });

    it('restartTerminal resets bellPending (HS-6603 §24.6)', () => {
      const d = tmpDataDir();
      const { sub } = makeSub();
      attach('bell-sec-5', d, sub);
      FakePty.lastSpawned!.emit('\x07');
      expect(getBellPending('bell-sec-5')).toBe(true);

      restartTerminal('bell-sec-5', d);
      expect(getBellPending('bell-sec-5')).toBe(false);
    });

    it('destroyTerminal drops bellPending state implicitly', () => {
      const d = tmpDataDir();
      const { sub } = makeSub();
      attach('bell-sec-6', d, sub);
      FakePty.lastSpawned!.emit('\x07');
      expect(getBellPending('bell-sec-6')).toBe(true);

      destroyTerminal('bell-sec-6');
      expect(getBellPending('bell-sec-6')).toBe(false);
      expect(listBellPendingForProject('bell-sec-6')).toEqual([]);
    });

    // HS-6766 — shells emit OSC title/CWD sequences (`\x1b]0;TITLE\x07`,
    // `\x1b]7;file://host/cwd\x07`, etc.) on every prompt, and Apple
    // Terminal's zshrc integration emits one at startup. The trailing
    // BEL terminator must NOT trip the bell indicator.
    it('ignores the BEL terminator of an OSC title sequence (HS-6766)', () => {
      const d = tmpDataDir();
      const { sub } = makeSub();
      attach('bell-osc-1', d, sub);
      FakePty.lastSpawned!.emit('\x1b]0;my-shell-title\x07');
      expect(getBellPending('bell-osc-1')).toBe(false);
    });

    it('ignores OSC 7 (working-directory) BEL terminators used by zsh on each prompt (HS-6766)', () => {
      const d = tmpDataDir();
      const { sub } = makeSub();
      attach('bell-osc-2', d, sub);
      FakePty.lastSpawned!.emit('\x1b]7;file://host/Users/me/project\x07');
      expect(getBellPending('bell-osc-2')).toBe(false);
    });

    it('ignores ST-terminated OSC sequences (ESC\\\\ terminator) (HS-6766)', () => {
      const d = tmpDataDir();
      const { sub } = makeSub();
      attach('bell-osc-3', d, sub);
      FakePty.lastSpawned!.emit('\x1b]0;foo\x1b\\');
      expect(getBellPending('bell-osc-3')).toBe(false);
    });

    it('still fires on a real BEL that is NOT inside an OSC string (HS-6766)', () => {
      const d = tmpDataDir();
      const { sub } = makeSub();
      attach('bell-osc-4', d, sub);
      // OSC terminator first, then a real bell after some text.
      FakePty.lastSpawned!.emit('\x1b]0;title\x07hello\x07');
      expect(getBellPending('bell-osc-4')).toBe(true);
    });

    it('tracks OSC state across chunk boundaries so a split BEL terminator does not fire (HS-6766)', () => {
      const d = tmpDataDir();
      const { sub } = makeSub();
      attach('bell-osc-5', d, sub);
      // OSC opens in chunk 1, continues in chunk 2, terminates in chunk 3.
      FakePty.lastSpawned!.emit('\x1b]0;lo');
      FakePty.lastSpawned!.emit('ng-title-split');
      FakePty.lastSpawned!.emit('\x07');
      expect(getBellPending('bell-osc-5')).toBe(false);
      // A real BEL after the OSC closes must still register.
      FakePty.lastSpawned!.emit('\x07');
      expect(getBellPending('bell-osc-5')).toBe(true);
    });

    it('real BEL immediately followed by an OSC title (Apple Terminal integration pattern) fires once (HS-6766)', () => {
      const d = tmpDataDir();
      const { sub } = makeSub();
      attach('bell-osc-6', d, sub);
      // Real bell, then an OSC sequence whose BEL terminator must NOT
      // re-arm the already-pending flag in a way that re-notifies on every
      // prompt. The flag is sticky either way, but this guards the detector
      // against mistakenly treating the terminator as a fresh bell event.
      FakePty.lastSpawned!.emit('\x07\x1b]0;title\x07');
      expect(getBellPending('bell-osc-6')).toBe(true);
    });

    it('resets OSC-scan state on restart so a mid-OSC process death does not poison the new PTY (HS-6766)', () => {
      const d = tmpDataDir();
      const { sub } = makeSub();
      attach('bell-osc-7', d, sub);
      // Process dies mid-OSC, leaving scanner in `inString` state.
      FakePty.lastSpawned!.emit('\x1b]0;partial');
      expect(getBellPending('bell-osc-7')).toBe(false);

      restartTerminal('bell-osc-7', d);
      // The fresh PTY emits a real bell (no OSC wrapping). The scanner must
      // have reset on restart — otherwise it would still be "inString" and
      // treat the BEL as an OSC terminator.
      FakePty.lastSpawned!.emit('\x07');
      expect(getBellPending('bell-osc-7')).toBe(true);
    });

    it('ignores DCS/APC/PM/SOS strings containing incidental BEL bytes (HS-6766)', () => {
      const d = tmpDataDir();
      const { sub } = makeSub();
      attach('bell-osc-8', d, sub);
      // DCS = ESC P ... ESC\\. The spec only terminates with ST, but some
      // emitters reuse BEL — either way, a BEL inside a DCS string should
      // not bubble up as a user-visible bell.
      FakePty.lastSpawned!.emit('\x1bP0;dcs-body\x07with-real\x1b\\');
      expect(getBellPending('bell-osc-8')).toBe(false);
    });
  });

  // HS-7264 — OSC 9 desktop notifications. The PTY emits `\x1b]9;<message>\x07`
  // (iTerm2 convention) when a shell wants to surface a human-readable message
  // like "Build done". The server stashes the message alongside bellPending so
  // the client can render a toast in addition to the bell glyph.
  describe('OSC 9 desktop notifications (HS-7264)', () => {
    it('captures the OSC 9 message and sets bellPending when a BEL-terminated notification arrives', async () => {
      const { getNotificationMessage } = await import('./registry.js');
      const d = tmpDataDir();
      const { sub } = makeSub();
      attach('osc9-1', d, sub);
      FakePty.lastSpawned!.emit('\x1b]9;Build done\x07');
      expect(getBellPending('osc9-1')).toBe(true);
      expect(getNotificationMessage('osc9-1')).toBe('Build done');
    });

    it('captures the OSC 9 message when the string is ST-terminated (ESC\\)', async () => {
      const { getNotificationMessage } = await import('./registry.js');
      const d = tmpDataDir();
      const { sub } = makeSub();
      attach('osc9-2', d, sub);
      FakePty.lastSpawned!.emit('\x1b]9;Tests passed\x1b\\');
      expect(getBellPending('osc9-2')).toBe(true);
      expect(getNotificationMessage('osc9-2')).toBe('Tests passed');
    });

    it('handles an OSC 9 payload that arrives split across PTY chunks', async () => {
      const { getNotificationMessage } = await import('./registry.js');
      const d = tmpDataDir();
      const { sub } = makeSub();
      attach('osc9-3', d, sub);
      const pty = FakePty.lastSpawned!;
      pty.emit('\x1b]9;Deploy ');
      expect(getNotificationMessage('osc9-3')).toBe(null);
      pty.emit('finished\x07');
      expect(getBellPending('osc9-3')).toBe(true);
      expect(getNotificationMessage('osc9-3')).toBe('Deploy finished');
    });

    it('ignores iTerm2 proprietary numeric subcommand forms (9;1;... progress, 9;4;... newer progress)', async () => {
      const { getNotificationMessage } = await import('./registry.js');
      const d = tmpDataDir();
      const { sub } = makeSub();
      attach('osc9-4', d, sub);
      // 9;4;3; is iTerm2's "set progress state=3" — a subcommand, not a human-
      // readable message. Must not fire a notification toast.
      FakePty.lastSpawned!.emit('\x1b]9;4;3;50\x07');
      expect(getNotificationMessage('osc9-4')).toBe(null);
    });

    it('does NOT flag OSC 0/1/2 titles or OSC 7 CWD pushes as notifications', async () => {
      const { getNotificationMessage } = await import('./registry.js');
      const d = tmpDataDir();
      const { sub } = makeSub();
      attach('osc9-5', d, sub);
      const pty = FakePty.lastSpawned!;
      pty.emit('\x1b]0;my-title\x07');
      pty.emit('\x1b]2;another-title\x07');
      pty.emit('\x1b]7;file://host/home/u\x07');
      expect(getNotificationMessage('osc9-5')).toBe(null);
      expect(getBellPending('osc9-5')).toBe(false);
    });

    it('a later OSC 9 message overwrites an earlier one (latest-wins semantics)', async () => {
      const { getNotificationMessage } = await import('./registry.js');
      const d = tmpDataDir();
      const { sub } = makeSub();
      attach('osc9-6', d, sub);
      const pty = FakePty.lastSpawned!;
      pty.emit('\x1b]9;First\x07');
      pty.emit('\x1b]9;Second\x07');
      expect(getNotificationMessage('osc9-6')).toBe('Second');
    });

    it('clearBellPending also clears the OSC 9 message so the tab re-activation resets both', async () => {
      const { getNotificationMessage } = await import('./registry.js');
      const d = tmpDataDir();
      const { sub } = makeSub();
      attach('osc9-7', d, sub);
      FakePty.lastSpawned!.emit('\x1b]9;Build done\x07');
      expect(getNotificationMessage('osc9-7')).toBe('Build done');
      clearBellPending('osc9-7');
      expect(getBellPending('osc9-7')).toBe(false);
      expect(getNotificationMessage('osc9-7')).toBe(null);
    });

    it('listBellPendingForProject surfaces the OSC 9 message alongside the terminal id', () => {
      const d = tmpDataDir();
      const { sub: a } = makeSub();
      const { sub: b } = makeSub();
      attach('osc9-8', d, a, { configOverride: { id: 'one', command: '/bin/sh' } }, 'one');
      const ptyOne = FakePty.lastSpawned!;
      attach('osc9-8', d, b, { configOverride: { id: 'two', command: '/bin/sh' } }, 'two');
      const ptyTwo = FakePty.lastSpawned!;
      ptyOne.emit('\x07');                         // plain bell, no message
      ptyTwo.emit('\x1b]9;Tests passed\x07');      // OSC 9 with message
      const entries = listBellPendingForProject('osc9-8').sort((x, y) => x.terminalId.localeCompare(y.terminalId));
      expect(entries).toEqual([
        { terminalId: 'one', message: null },
        { terminalId: 'two', message: 'Tests passed' },
      ]);
    });
  });

  // HS-6799 — the first real client attach to an eager-spawned PTY must clear
  // the startup scrollback (shell welcome, PROMPT_SP EOL mark, OSC preamble)
  // that was emitted at DEFAULT 80×24 before the client had dims, resize the
  // PTY to the client's real pane geometry, and poke the shell with Ctrl-L
  // so the prompt is redrawn at the correct width. Otherwise the 80×24 bytes
  // replayed in a wider pane produce stray chars at the top.
  describe('eager-spawn first-attach cleanup (HS-6799)', () => {
    it('first real attach with dims clears scrollback accumulated during eager-spawn', () => {
      const d = tmpDataDir();
      ensureSpawned('eager-1', d, 'main');
      const pty = FakePty.lastSpawned!;
      // Simulate the shell emitting a welcome banner + prompt at 80×24
      // before any client has attached.
      pty.emit('Restored session: Wed Apr 22 13:25:15 PST 2026\r\n');
      pty.emit('% '.repeat(40));
      pty.emit('user@host %');
      expect(getTerminalStatus('eager-1', d, 'main').scrollbackBytes).toBeGreaterThan(0);

      const { sub } = makeSub();
      const result = attach('eager-1', d, sub, { cols: 180, rows: 48 }, 'main');
      expect(result.history.length).toBe(0);
      expect(getTerminalStatus('eager-1', d, 'main').scrollbackBytes).toBe(0);
    });

    it('first real attach with dims resizes the eager-spawned PTY to the client geometry', () => {
      const d = tmpDataDir();
      ensureSpawned('eager-2', d, 'main');
      const pty = FakePty.lastSpawned!;
      expect(pty.cols).toBe(80);
      expect(pty.rows).toBe(24);

      const { sub } = makeSub();
      attach('eager-2', d, sub, { cols: 160, rows: 50 }, 'main');
      expect(pty.resizes).toContainEqual([160, 50]);
      expect(getTerminalStatus('eager-2', d, 'main').cols).toBe(160);
      expect(getTerminalStatus('eager-2', d, 'main').rows).toBe(50);
    });

    it('first real attach sends Ctrl-L (\\x0c) to the PTY so the shell redraws its prompt', () => {
      const d = tmpDataDir();
      ensureSpawned('eager-3', d, 'main');
      const pty = FakePty.lastSpawned!;
      expect(pty.writes).toEqual([]);

      const { sub } = makeSub();
      attach('eager-3', d, sub, { cols: 120, rows: 40 }, 'main');
      expect(pty.writes).toContain('\x0c');
    });

    it('SECOND attach (re-attach) does NOT re-clear scrollback or re-send Ctrl-L', () => {
      const d = tmpDataDir();
      ensureSpawned('eager-4', d, 'main');
      const pty = FakePty.lastSpawned!;

      const { sub: first } = makeSub();
      attach('eager-4', d, first, { cols: 120, rows: 40 }, 'main');
      // Post-first-attach scrollback: shell's Ctrl-L response (we simulate).
      pty.emit('\x1b[2J\x1b[Huser@host %');
      const scrollbackBeforeReattach = getTerminalStatus('eager-4', d, 'main').scrollbackBytes;
      expect(scrollbackBeforeReattach).toBeGreaterThan(0);
      const writesBeforeReattach = pty.writes.length;

      // Reconnect (e.g. browser refresh) — same terminal, second subscriber.
      const { sub: second } = makeSub();
      const result = attach('eager-4', d, second, { cols: 120, rows: 40 }, 'main');
      expect(result.history.length).toBe(scrollbackBeforeReattach);
      expect(getTerminalStatus('eager-4', d, 'main').scrollbackBytes).toBe(scrollbackBeforeReattach);
      // No new Ctrl-L — the re-attach flow only sees live output.
      expect(pty.writes.length).toBe(writesBeforeReattach);
    });

    it('lazy-spawn (no eager-spawn) does NOT trigger the cleanup — PTY is born at the client dims', () => {
      const d = tmpDataDir();
      const { sub } = makeSub();
      // No ensureSpawned. Attach spawns fresh at the client's dims.
      attach('lazy-1', d, sub, { cols: 140, rows: 44 }, 'main');
      const pty = FakePty.lastSpawned!;
      // PTY was born at the requested geometry — no resize on create.
      expect(pty.cols).toBe(140);
      expect(pty.rows).toBe(44);
      expect(pty.resizes).toEqual([]);
      // No stray Ctrl-L was sent.
      expect(pty.writes).toEqual([]);
    });

    it('first attach WITHOUT client dims leaves the eager-spawned PTY untouched (history replayed as-is)', () => {
      const d = tmpDataDir();
      ensureSpawned('eager-5', d, 'main');
      const pty = FakePty.lastSpawned!;
      pty.emit('welcome');

      const { sub } = makeSub();
      const result = attach('eager-5', d, sub, {}, 'main');
      // Without dims to resize to, we can't safely redraw — fall back to
      // replaying whatever scrollback exists at the server's current dims.
      expect(result.history.toString()).toBe('welcome');
      expect(pty.writes).not.toContain('\x0c');
      expect(pty.resizes).toEqual([]);
    });
  });
});
