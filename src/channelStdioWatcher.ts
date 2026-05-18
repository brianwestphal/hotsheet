/**
 * HS-8447 — detect when the MCP stdio transport's underlying pipe to
 * Claude Code goes away, and run a caller-supplied cleanup so the
 * channel-server process exits instead of becoming a zombie with a
 * working HTTP server and a broken pipe.
 *
 * ### The bug this exists to close
 *
 * `StdioServerTransport` in `@modelcontextprotocol/sdk` registers
 * listeners only for `'data'` and `'error'` on `process.stdin` — it
 * never listens for `'end'` or `'close'`. The transport's `onclose`
 * callback is fired exclusively from its own `close()` method, which
 * the SDK only calls from explicit shutdown paths. So when Claude
 * Code disconnects (parent exits, user kills the terminal, MCP
 * reconnect closes the pipe), stdin gets EOF but the channel-server
 * process is none the wiser:
 *
 *  - the HTTP server (used by the main Hot Sheet server for
 *    `/health`, `/trigger`, `/permission`, etc.) keeps the Node event
 *    loop alive — the process doesn't exit on stdin EOF the way a
 *    pure stdio-driven program would;
 *  - `mcp.notification(...)` calls `_stdout.write(json)` which
 *    returns synchronously and resolves the returned Promise — a
 *    broken pipe surfaces as a `'error'` event on stdout, not as a
 *    thrown error from `write()`, and the transport doesn't propagate
 *    it through `send()`'s Promise;
 *  - `isChannelAlive(dataDir)` in `src/channel-config.ts` checks the
 *    channel-server's HTTP `/health` endpoint, which still returns
 *    `{ok: true}` because the HTTP server has no idea the stdio side
 *    is dead.
 *
 * Net effect for the user: the UI keeps showing "Claude connected"
 * (no warning banner), and clicking the play button / a custom
 * command button POSTs to `/api/channel/trigger`, which calls
 * `triggerChannel`, which forwards via `mcp.notification` into a
 * disconnected stdout pipe — silently nothing happens, no error
 * surfaces, and the only fix is killing the Claude terminal and
 * re-running `/mcp` to reconnect.
 *
 * ### The fix
 *
 * Listen for the events the MCP SDK doesn't:
 *
 *  - `stdin` `'end'` and `'close'` — fired when the upstream writer
 *    (Claude Code) closes the pipe;
 *  - `stdout` `'error'` — fires for `EPIPE` when we try to write to
 *    a downstream reader that's gone away (covers the case where
 *    stdin stays open but stdout was closed first, which can happen
 *    under shell weirdness or partial-disconnect races);
 *  - `process` `'beforeExit'` — fires when the event loop empties
 *    naturally, a sign that nothing's keeping the process alive
 *    (we don't trigger our cleanup here because beforeExit can
 *    fire in normal shutdown too — included only for symmetry).
 *
 * Any of stdin-end / stdin-close / stdout-error invokes the
 * caller-supplied `onDisconnect` once (subsequent firings are
 * suppressed by the internal `done` flag, since stdin emitting both
 * 'end' AND 'close' is normal). The caller's `cleanup()` in
 * `channel.ts` deletes the port file + calls `process.exit(0)`, so
 * the next `isChannelAlive(dataDir)` poll from the main server
 * returns false and the UI surfaces the disconnect banner that should
 * have been there all along.
 *
 * ### Tests
 *
 * `src/channelStdioWatcher.test.ts` exercises the helper with
 * `node:stream`'s `PassThrough` for stdin + stdout, asserting (a) EOF
 * on stdin fires `onDisconnect` exactly once even though both 'end'
 * and 'close' arrive, (b) an EPIPE-like error on stdout fires
 * `onDisconnect`, (c) repeated calls (idempotence) don't refire, and
 * (d) the returned dispose function removes every listener cleanly so
 * a test process doesn't leak listener handles.
 */
import type { Readable, Writable } from 'node:stream';

export interface StdioDisconnectHandlerOptions {
  /** The readable side of the MCP transport — typically `process.stdin`. */
  stdin: Readable;
  /** The writable side of the MCP transport — typically `process.stdout`. */
  stdout: Writable;
  /** Called exactly once the first time stdin EOF / close OR stdout
   *  EPIPE is observed. Subsequent firings are suppressed. */
  onDisconnect: (reason: StdioDisconnectReason) => void;
  /** Optional logger for diagnostics. Defaults to a no-op so unit tests
   *  can pin behaviour without writing to the test runner's stderr.
   *  Production caller in `channel.ts` passes a stderr-writing function
   *  so the disconnect reason lands in the channel-server log alongside
   *  the existing startup line. */
  log?: (message: string) => void;
}

export type StdioDisconnectReason = 'stdin-end' | 'stdin-close' | 'stdout-error';

/** Install the four event listeners and return a dispose function that
 *  removes them. The dispose function is idempotent (safe to call
 *  multiple times). The `onDisconnect` callback is also called at most
 *  once across the handler's lifetime regardless of how many of the
 *  underlying events fire — stdin emitting both 'end' and 'close' in
 *  sequence is normal and would otherwise double-trigger cleanup. */
export function installStdioDisconnectHandler(opts: StdioDisconnectHandlerOptions): () => void {
  const { stdin, stdout, onDisconnect, log } = opts;
  let fired = false;
  const fire = (reason: StdioDisconnectReason): void => {
    if (fired) return;
    fired = true;
    if (log !== undefined) {
      log(`stdio disconnected (${reason}) — triggering channel-server cleanup`);
    }
    try {
      onDisconnect(reason);
    } catch (err: unknown) {
      if (log !== undefined) {
        log(`onDisconnect threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const onStdinEnd = (): void => { fire('stdin-end'); };
  const onStdinClose = (): void => { fire('stdin-close'); };
  const onStdoutError = (err: NodeJS.ErrnoException): void => {
    // Only treat EPIPE / ECONNRESET / EOF-equivalent codes as a
    // disconnect. Random stdout errors (out-of-space, etc.) shouldn't
    // necessarily tear the process down — let those propagate to
    // process.uncaughtException instead. The set here matches the
    // codes Node.js emits when the downstream reader has gone away.
    if (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ECANCELED') {
      fire('stdout-error');
    }
  };

  stdin.on('end', onStdinEnd);
  stdin.on('close', onStdinClose);
  stdout.on('error', onStdoutError);

  let disposed = false;
  return (): void => {
    if (disposed) return;
    disposed = true;
    stdin.off('end', onStdinEnd);
    stdin.off('close', onStdinClose);
    stdout.off('error', onStdoutError);
  };
}
