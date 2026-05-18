/**
 * HS-8447 — unit tests for `installStdioDisconnectHandler`.
 *
 * Pins the four guarantees the production caller in `src/channel.ts`
 * depends on:
 *
 *  1. stdin EOF (`'end'` event) fires `onDisconnect` exactly once;
 *  2. stdin close (`'close'` event) fires `onDisconnect` exactly once;
 *  3. stdout `'error'` with code `EPIPE` (or `ECONNRESET`) fires
 *     `onDisconnect`;
 *  4. across the handler's lifetime `onDisconnect` is invoked AT MOST
 *     once, even when multiple disconnect signals arrive (stdin
 *     emitting both 'end' AND 'close' in sequence is the common case);
 *  5. the returned dispose function removes every listener — verified
 *     by `listenerCount` before / after dispose — so a test process
 *     doesn't leak handles and a production caller can re-install on
 *     reconnect without doubling up;
 *  6. unrelated stdout errors (e.g. `ENOSPC`) DO NOT fire
 *     `onDisconnect` — only the disconnect-shaped error codes do.
 */
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { installStdioDisconnectHandler } from './channelStdioWatcher.js';

function makePipes(): { stdin: PassThrough; stdout: PassThrough } {
  return { stdin: new PassThrough(), stdout: new PassThrough() };
}

describe('installStdioDisconnectHandler (HS-8447)', () => {
  it('fires onDisconnect with stdin-end when stdin emits end', () => {
    const { stdin, stdout } = makePipes();
    const onDisconnect = vi.fn();
    installStdioDisconnectHandler({ stdin, stdout, onDisconnect });
    stdin.emit('end');
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith('stdin-end');
  });

  it('fires onDisconnect with stdin-close when stdin emits close', () => {
    const { stdin, stdout } = makePipes();
    const onDisconnect = vi.fn();
    installStdioDisconnectHandler({ stdin, stdout, onDisconnect });
    stdin.emit('close');
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith('stdin-close');
  });

  it('fires onDisconnect with stdout-error when stdout emits EPIPE', () => {
    const { stdin, stdout } = makePipes();
    const onDisconnect = vi.fn();
    installStdioDisconnectHandler({ stdin, stdout, onDisconnect });
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    // PassThrough re-emits 'error' on listeners; emit directly so the
    // error doesn't end up unhandled in the test process.
    stdout.emit('error', epipe);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith('stdout-error');
  });

  it('treats ECONNRESET on stdout as a disconnect (same shape as EPIPE)', () => {
    const { stdin, stdout } = makePipes();
    const onDisconnect = vi.fn();
    installStdioDisconnectHandler({ stdin, stdout, onDisconnect });
    stdout.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith('stdout-error');
  });

  it('ignores unrelated stdout errors (only disconnect-shaped codes fire)', () => {
    const { stdin, stdout } = makePipes();
    const onDisconnect = vi.fn();
    installStdioDisconnectHandler({ stdin, stdout, onDisconnect });
    stdout.emit('error', Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    stdout.emit('error', Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('invokes onDisconnect at most once even when stdin fires end + close in sequence', () => {
    // PassThrough naturally emits 'end' followed by 'close' on shutdown,
    // and a production stdin pipe (Claude Code disconnect) follows the
    // same pattern. The dedup is what stops cleanup() from racing
    // against itself.
    const { stdin, stdout } = makePipes();
    const onDisconnect = vi.fn();
    installStdioDisconnectHandler({ stdin, stdout, onDisconnect });
    stdin.emit('end');
    stdin.emit('close');
    stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith('stdin-end');
  });

  it('calls the log callback for each disconnect signal observed', () => {
    const { stdin, stdout } = makePipes();
    const log = vi.fn();
    installStdioDisconnectHandler({ stdin, stdout, onDisconnect: () => { /* noop */ }, log });
    stdin.emit('end');
    // The log helper is called with a single descriptive line; we don't
    // assert the exact wording (it's diagnostic, not user-facing) but
    // we DO assert it carries the reason so a log dive shows which
    // signal fired.
    expect(log).toHaveBeenCalled();
    const message = log.mock.calls[0]?.[0] as string;
    expect(message).toContain('stdin-end');
  });

  it('swallows + logs errors thrown by onDisconnect so the watcher does not crash the process', () => {
    const { stdin, stdout } = makePipes();
    const log = vi.fn();
    const onDisconnect = vi.fn(() => { throw new Error('cleanup blew up'); });
    installStdioDisconnectHandler({ stdin, stdout, onDisconnect, log });
    expect(() => stdin.emit('end')).not.toThrow();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    // The log helper saw the throw — pulls the second call (first is
    // the "stdio disconnected" line, second is the "onDisconnect threw"
    // line).
    expect(log.mock.calls.length).toBeGreaterThanOrEqual(2);
    const errorLine = log.mock.calls[1]?.[0] as string;
    expect(errorLine).toContain('cleanup blew up');
  });

  it('dispose() removes every listener and is idempotent', () => {
    const { stdin, stdout } = makePipes();
    const onDisconnect = vi.fn();
    const stdinEndBefore = stdin.listenerCount('end');
    const stdinCloseBefore = stdin.listenerCount('close');
    const stdoutErrorBefore = stdout.listenerCount('error');
    const dispose = installStdioDisconnectHandler({ stdin, stdout, onDisconnect });
    expect(stdin.listenerCount('end')).toBe(stdinEndBefore + 1);
    expect(stdin.listenerCount('close')).toBe(stdinCloseBefore + 1);
    expect(stdout.listenerCount('error')).toBe(stdoutErrorBefore + 1);
    dispose();
    expect(stdin.listenerCount('end')).toBe(stdinEndBefore);
    expect(stdin.listenerCount('close')).toBe(stdinCloseBefore);
    expect(stdout.listenerCount('error')).toBe(stdoutErrorBefore);
    // Second call is a no-op (no double-removal / underflow).
    expect(() => { dispose(); }).not.toThrow();
    expect(stdin.listenerCount('end')).toBe(stdinEndBefore);
  });

  it('events fired after dispose() do not invoke onDisconnect', () => {
    const { stdin, stdout } = makePipes();
    const onDisconnect = vi.fn();
    const dispose = installStdioDisconnectHandler({ stdin, stdout, onDisconnect });
    dispose();
    // Re-attach a no-op error listener after dispose so the EPIPE-shaped
    // emit below doesn't surface as a Node "unhandled error" throw —
    // the assertion is about whether `onDisconnect` was called, not
    // about EventEmitter's default behaviour with no listeners.
    stdout.on('error', () => { /* swallow */ });
    stdin.emit('end');
    stdin.emit('close');
    stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    expect(onDisconnect).not.toHaveBeenCalled();
  });
});
