import type { TerminalState, TerminalStatus } from '../../api/terminal.js';
import type { TerminalConfig } from '../config.js';
import type { RingBuffer } from '../ringBuffer.js';

/**
 * HS-8189 — public types for the terminals registry.
 *
 * Pre-fix `src/terminals/registry.ts` was a 1006-line god module with 36
 * exports covering attach / detach / spawn / kill / destroy + bell + cwd
 * + pid + spinner + scanner-match + status. This file pulls out the
 * type/interface declarations so the four behavioral modules
 * (`./attach.ts` / `./lifecycle.ts` / `./state.ts`) can share them without
 * circular imports.
 *
 * HS-8630 — `TerminalState` + `TerminalStatus` are now defined once as the wire
 * SSOT in `src/api/terminal.ts` (inferred from the zod schemas); imported for
 * local use (`AttachResult` / `TerminalStatus` consumers below) + re-exported
 * so existing importers keep working.
 */
export type { TerminalState, TerminalStatus };

export interface TerminalSubscriber {
  onData(chunk: Buffer): void;
  onExit(exitCode: number): void;
}

export interface AttachResult {
  alive: boolean;
  cols: number;
  rows: number;
  command: string;
  exitCode: number | null;
  scrollbackBytes: number;
  /** Full scrollback at attach time; the subscriber should replay this before live data. */
  history: Buffer;
  /**
   * HS-8218 — true when the caller passed `noSpawn: true` AND no session
   * exists for `(secret, terminalId)`. In that case the registry returns
   * an empty result WITHOUT creating a session or spawning a PTY, and
   * the subscriber is NOT added. The transport (HTTP / WS) is expected
   * to surface this to the client so the consumer can fall back to a
   * non-live path.
   */
  noSession?: boolean;
}

/** Minimal PTY interface the registry depends on — matches node-pty's IPty. */
export interface PtyLike {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface SpawnArgs {
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

export type PtyFactory = (args: SpawnArgs) => PtyLike;

/** Options passed through `attach()` for terminals that are not registered in settings. */
export interface AttachOptions {
  cols?: number;
  rows?: number;
  /**
   * When the terminalId is not present in settings (e.g. a dynamic terminal
   * created via POST /api/terminal/create), the caller supplies the TerminalConfig
   * here so the registry can spawn without consulting settings.
   */
  configOverride?: TerminalConfig;
  /**
   * HS-8218 — when true, never create a session or spawn a fresh PTY:
   * if `(secret, terminalId)` has no live session, return an
   * `AttachResult` with `noSession: true` and don't add the subscriber.
   */
  noSpawn?: boolean;
}

/** Internal storage shape for one (secret, terminalId) session. Shared
 *  across the split modules so each can mutate the relevant slice
 *  (attach.ts adopts subscribers + adjusts cols/rows; lifecycle.ts
 *  spawns / kills the pty; state.ts reads bell / cwd / pid). */
export interface SessionState {
  pty: PtyLike | null;
  ptyDisposables: { dispose(): void }[];
  startedAt: number | null;
  command: string | null;
  exitCode: number | null;
  cols: number;
  rows: number;
  scrollback: RingBuffer;
  subscribers: Set<TerminalSubscriber>;
  terminalId: string;
  /** Optional config override (used by dynamic terminals not in settings). */
  configOverride: TerminalConfig | null;
  /** True when the process has rung the bell (`\x07`) since the flag was last
   *  cleared via clearBellPending(). HS-6603 / §24. */
  bellPending: boolean;
  /** Most recent OSC 9 payload (iTerm2-style desktop notification — HS-7264). */
  notificationMessage: string | null;
  /** Most recent OSC 7 CWD pushed by the shell — HS-7278. */
  currentCwd: string | null;
  /** Cross-chunk state for `scanPtyChunk`. HS-6766. */
  bellScanInString: boolean;
  bellScanAfterEsc: boolean;
  /** OSC accumulator for HS-7264 payload extraction. HS-8230 — switched
   *  from `string | null` to `number[] | null` so multi-byte UTF-8
   *  sequences round-trip correctly (UTF-8 decode happens once on close
   *  in `oscScanner.finishOscString`). */
  oscAccumulator: number[] | null;
  /** True once a real client has attached. HS-6799. */
  hasBeenAttached: boolean;
  /** HS-6702 — wall-clock ms timestamp of the last PTY chunk. */
  lastOutputAtMs: number | null;
  /** HS-6702 — wall-clock ms of the last chunk containing a Claude busy-spinner glyph. */
  lastSpinnerAtMs: number | null;
}
