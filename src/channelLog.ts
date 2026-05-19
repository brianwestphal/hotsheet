/**
 * HS-8447 follow-up — append-only diagnostic log written to
 * `<dataDir>/mcp.log` so we can post-mortem unexpected channel-server
 * disconnects.
 *
 * The HS-8447 fix (`channelStdioWatcher.ts` + SIGHUP handler) closed
 * the silent-disconnect failure mode but the user is now reporting the
 * inverse symptom — the channel-server is exiting cleanly enough that
 * the UI surfaces the reconnect banner, but Claude Code's own MCP
 * client list still says the channel is connected. That means the
 * channel-server is dying without taking Claude's MCP client with it,
 * and we have no first-hand record of which event tore the connection
 * down. This logger gives us one.
 *
 * ### Why a file, not just stderr
 *
 * The channel-server is spawned by Claude Code with stderr piped into
 * Claude's own console. The user can't easily inspect that stream
 * mid-session — they'd have to relaunch Claude with a redirect. A
 * dedicated file under `<dataDir>` is always inspectable with
 * `tail -f <dataDir>/mcp.log` from any terminal and survives a
 * channel-server crash + respawn.
 *
 * ### Shape
 *
 *  - Append-only, line-oriented. Each line is
 *    `[ISO timestamp] [pid] event: details`.
 *  - Bounded at 1 MiB per file. On the next write that would push past
 *    that, the current file is renamed `<dataDir>/mcp.log.old`
 *    (overwriting any prior `.old`), and a fresh log starts. One
 *    rotation slot is enough for our use case — a chronic-disconnect
 *    bug surfaces within minutes, not days.
 *  - Synchronous writes so the last few events still land if the
 *    process exits abruptly. A diagnostic log we lose on crash is
 *    worse than useless.
 *  - Write failures are swallowed. The log is best-effort
 *    instrumentation; we don't want to crash the channel server
 *    because the filesystem went read-only or the data dir was deleted
 *    underneath us.
 *  - On startup, the first call to `appendChannelLogEntry` injects a
 *    blank line before its event so successive process lifetimes are
 *    visually separated in the file.
 */
import { appendFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ChannelLogger {
  /** Append a structured event line to the log file. */
  log: (event: string, details?: string) => void;
}

/** Maximum size before the active log is rotated to `<path>.old`. */
export const CHANNEL_LOG_MAX_BYTES = 1_048_576;

/** Options for `createChannelLogger`. */
export interface ChannelLoggerOptions {
  /** Optional label appended after the pid in the line prefix.
   *  HS-8456 — main-server callers pass `'main'` so their entries appear
   *  as `[pid 4174 main]` and stay visually distinct from the channel
   *  server's own `[pid 12964]` entries when both write to the same
   *  `<dataDir>/mcp.log`. Default `undefined` preserves the legacy
   *  `[pid <n>]` shape. */
  pidLabel?: string;
}

/** Build a logger that writes to `<dataDir>/mcp.log`. The logger is
 *  best-effort — every filesystem error is swallowed so the channel
 *  server never crashes because the log path went away. */
export function createChannelLogger(logPath: string, options: ChannelLoggerOptions = {}): ChannelLogger {
  let injectedBlankLine = false;
  const pidSuffix = options.pidLabel !== undefined && options.pidLabel !== '' ? ` ${options.pidLabel}` : '';
  return {
    log(event: string, details?: string): void {
      try {
        const size = safeStatSize(logPath);
        if (size >= CHANNEL_LOG_MAX_BYTES) {
          try { renameSync(logPath, `${logPath}.old`); } catch { /* ignore */ }
        }
        const ts = new Date().toISOString();
        const detailsText = details === undefined || details === '' ? '' : ` ${details}`;
        // On the very first write of this process, prepend a blank
        // line IF the file already has content from a prior process —
        // makes successive lifetimes easy to spot in `tail` output.
        const prefix = !injectedBlankLine && size > 0 ? '\n' : '';
        injectedBlankLine = true;
        appendFileSync(logPath, `${prefix}[${ts}] [pid ${process.pid}${pidSuffix}] ${event}:${detailsText}\n`, 'utf-8');
      } catch {
        // Log writes must never crash the channel server.
      }
    },
  };
}

/** HS-8456 — per-dataDir main-server logger cache. The main server has
 *  one process for many projects (each with its own dataDir); reusing a
 *  single logger per dataDir avoids re-doing the blank-separator
 *  injection on every event. */
const mainServerLoggers = new Map<string, ChannelLogger>();

/** HS-8456 — append a single event to `<dataDir>/mcp.log` from the main
 *  server, tagged so it's visually distinguishable from the channel
 *  server's own entries. Use for channel-state decisions (alive/dead
 *  transitions, cleanupStaleChannel outcomes, version mismatches) where
 *  cross-process correlation matters during a disconnect post-mortem.
 *
 *  Identical failure-open contract as `createChannelLogger`: a
 *  filesystem error never throws. */
export function appendMainServerEvent(dataDir: string, event: string, details?: string): void {
  let logger = mainServerLoggers.get(dataDir);
  if (logger === undefined) {
    logger = createChannelLogger(join(dataDir, 'mcp.log'), { pidLabel: 'main' });
    mainServerLoggers.set(dataDir, logger);
  }
  logger.log(event, details);
}

/** HS-8456 — test-only escape hatch. The per-dataDir logger cache memoises
 *  the blank-separator state across calls, which is what we want in
 *  production but trips up tests that recreate the file under a fresh
 *  temp dir per case. Exported so the test file can clear between cases.
 *  Not part of the public API. */
export function _resetMainServerLoggersForTesting(): void {
  mainServerLoggers.clear();
}

/** Return the byte size of `path`, or `0` if `path` does not exist
 *  (the common case for a fresh data dir). Any other stat error is
 *  treated as "unknown / start fresh" so the rotation check stays
 *  conservative. */
function safeStatSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
