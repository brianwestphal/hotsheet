import { StringDecoder } from 'node:string_decoder';

import { type ChildProcess, spawn } from 'child_process';
import { Hono } from 'hono';

import { addLogEntry, updateLogEntry } from '../db/commandLog.js';
import { PARTIAL_OUTPUT_CAP_BYTES } from '../limits.js';
import type { AppEnv } from '../types.js';
import { notifyChange } from './notify.js';
import { parseBody, ShellExecSchema, ShellKillSchema } from './validation.js';

export const shellRoutes = new Hono<AppEnv>();

const PARTIAL_TRUNCATION_MARKER = '[output truncated]\n';

/** Pure helper — append a chunk to the existing partial, applying the
 *  head-truncation cap. Exported for testability.
 *  HS-8557 — the head-trunc slice runs at code-unit (UTF-16 code unit)
 *  boundaries; if the cut lands inside a surrogate pair (only matters for
 *  characters above U+FFFF, e.g. an emoji at exactly the wrong offset),
 *  the result would carry a lone low-surrogate code unit at the start.
 *  After slicing, shift by one if the first code unit IS a low surrogate
 *  so the kept portion never starts mid-pair. */
export function appendPartialOutput(prev: string, chunk: string): string {
  const next = prev + chunk;
  if (next.length <= PARTIAL_OUTPUT_CAP_BYTES) return next;
  const keep = PARTIAL_OUTPUT_CAP_BYTES - PARTIAL_TRUNCATION_MARKER.length;
  let kept = next.slice(next.length - keep);
  // Low surrogate range: 0xDC00 - 0xDFFF. A code unit in this range is
  // only valid as the SECOND half of a surrogate pair; alone it's
  // malformed. Drop it so the displayed output never starts with a
  // broken codepoint.
  const firstCode = kept.charCodeAt(0);
  if (firstCode >= 0xDC00 && firstCode <= 0xDFFF) kept = kept.slice(1);
  return PARTIAL_TRUNCATION_MARKER + kept;
}

/**
 * HS-8549 — `ShellProcessRegistry` owns the three module-level Maps that
 * pre-fix were juggled by hand across every spawn / kill / close / chunk
 * path. Each lifecycle event now calls exactly one method, which makes
 * the "remember to clear killedProcesses on close AND release the
 * partial buffer" coordination invariant readable in one place instead
 * of spread across five callsites.
 *
 *   - `register(logId, child)` — tracks a freshly-spawned child.
 *   - `markKilled(logId)` — adds to the killed set so the close handler
 *      can surface "Canceled" instead of "Killed by SIGTERM".
 *   - `wasKilled(logId)` — read-then-clear (close handler consumes).
 *   - `recordChunk(logId, chunk)` — appends to the partial buffer with
 *      the HS-7982 head-truncation cap.
 *   - `release(logId)` — removes from `running` + clears the partial
 *      buffer. Called from `close` AND `error`.
 *   - `get(logId)` — peek the live ChildProcess (kill route + grace timer).
 *   - `runningIds()` — snapshot for `/shell/running` + shutdown.
 *   - `partial(logId)` — peek the partial buffer for `/shell/running`.
 *   - `size()` — count for `_runningShellCommandCountForTesting`.
 *
 * The Maps are private; nothing outside this module mutates them.
 */
class ShellProcessRegistry {
  private readonly running = new Map<number, ChildProcess>();
  private readonly killed = new Set<number>();
  private readonly partials = new Map<number, string>();

  register(logId: number, child: ChildProcess): void {
    this.running.set(logId, child);
  }
  markKilled(logId: number): void {
    this.killed.add(logId);
  }
  /** Read-then-clear: the close handler consumes the "killed?" bit
   *  once when deciding the exit summary. */
  wasKilled(logId: number): boolean {
    const was = this.killed.has(logId);
    this.killed.delete(logId);
    return was;
  }
  recordChunk(logId: number, chunk: string): void {
    this.partials.set(logId, appendPartialOutput(this.partials.get(logId) ?? '', chunk));
  }
  release(logId: number): void {
    this.running.delete(logId);
    this.partials.delete(logId);
  }
  get(logId: number): ChildProcess | undefined {
    return this.running.get(logId);
  }
  has(logId: number): boolean {
    return this.running.has(logId);
  }
  runningIds(): number[] {
    return Array.from(this.running.keys());
  }
  partial(logId: number): string | undefined {
    return this.partials.get(logId);
  }
  size(): number {
    return this.running.size;
  }
}

const registry = new ShellProcessRegistry();

/**
 * HS-8549 — extracted from the `/shell/exec` handler. Owns the spawn +
 * event-wire logic so the handler reduces to parsing + log-write +
 * delegation. The child process's lifecycle is fully encapsulated:
 * stdout / stderr are buffered through a `StringDecoder` (HS-8557 — UTF-8
 * chunk-boundary safety), `recordChunk` keeps the partial buffer in sync,
 * `close` writes the final log entry + notifies long-poll waiters,
 * `error` does the same with a spawn-error summary.
 */
function spawnTrackedShellCommand(logId: number, command: string, name: string | undefined, cwd: string): void {
  const child = spawn(command, { shell: true, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  registry.register(logId, child);

  let stdout = '';
  let stderr = '';
  // HS-8557 — `StringDecoder` buffers incomplete multi-byte UTF-8
  // sequences across chunk boundaries. See the helper's full rationale
  // (this routes module had the original `data.toString()` bug pre-fix).
  // One decoder per stream since each has its own byte boundary state.
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');

  child.stdout.on('data', (data: Buffer) => {
    const chunk = stdoutDecoder.write(data);
    stdout += chunk;
    registry.recordChunk(logId, chunk);
  });
  child.stderr.on('data', (data: Buffer) => {
    const chunk = stderrDecoder.write(data);
    stderr += chunk;
    registry.recordChunk(logId, chunk);
  });

  child.on('close', (code, signal) => {
    const wasCanceled = registry.wasKilled(logId);
    // HS-8557 — flush trailing buffered bytes so an incomplete UTF-8
    // sequence interrupted by the process closing mid-character gets
    // emitted as a single replacement char rather than silently
    // dropped. `.end()` returns the flushed string ('' when empty).
    const stdoutFlush = stdoutDecoder.end();
    const stderrFlush = stderrDecoder.end();
    if (stdoutFlush.length > 0) {
      stdout += stdoutFlush;
      registry.recordChunk(logId, stdoutFlush);
    }
    if (stderrFlush.length > 0) {
      stderr += stderrFlush;
      registry.recordChunk(logId, stderrFlush);
    }
    registry.release(logId);
    const output = (stdout + (stderr ? '\n--- stderr ---\n' + stderr : '')).trim();
    const exitSummary = wasCanceled ? 'Canceled'
      : code === 0 ? 'Completed (exit 0)'
      : signal !== null ? `Killed by ${signal}`
      : `Exited with code ${code ?? 'unknown'}`;
    const combinedDetail = command + '\n---SHELL_OUTPUT---\n' + output;
    if (logId > 0) {
      const label = name !== undefined && name !== '' ? name : command.slice(0, 100);
      updateLogEntry(logId, { summary: `${label} — ${exitSummary}`, detail: combinedDetail })
        .catch((err: unknown) => { console.warn('[shell] updateLogEntry on close failed:', err); });
    } else {
      addLogEntry('shell_command', 'outgoing', exitSummary, combinedDetail)
        .catch((err: unknown) => { console.warn('[shell] addLogEntry on close failed:', err); });
    }
    notifyChange();
  });

  child.on('error', (err) => {
    registry.release(logId);
    const combinedDetail = command + '\n---SHELL_OUTPUT---\n' + (err.stack ?? err.message);
    if (logId > 0) {
      updateLogEntry(logId, { summary: `${command.slice(0, 100)} — Error: ${err.message}`, detail: combinedDetail })
        .catch((logErr: unknown) => { console.warn('[shell] updateLogEntry on spawn-error failed:', logErr); });
    } else {
      addLogEntry('shell_command', 'outgoing', `Error: ${err.message}`, combinedDetail)
        .catch((logErr: unknown) => { console.warn('[shell] addLogEntry on spawn-error failed:', logErr); });
    }
    notifyChange();
  });
}

shellRoutes.post('/shell/exec', async (c) => {
  const dataDir = c.get('dataDir');
  const raw: unknown = await c.req.json();
  const parsed = parseBody(ShellExecSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const command = parsed.data.command;
  const name = parsed.data.name;

  // The project root is the parent of the .hotsheet data dir.
  const cwd = dataDir + '/..';
  // Use the user-supplied button name as the summary when present.
  const summary = name !== undefined && name !== '' ? name : command.slice(0, 200);
  const logEntry = await addLogEntry('shell_command', 'outgoing', summary, command);

  spawnTrackedShellCommand(logEntry.id, command, name, cwd);
  return c.json({ id: logEntry.id });
});

shellRoutes.post('/shell/kill', async (c) => {
  const raw: unknown = await c.req.json();
  const parsed = parseBody(ShellKillSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const child = registry.get(parsed.data.id);
  if (!child) {
    return c.json({ error: 'Process not found or already finished' }, 404);
  }
  registry.markKilled(parsed.data.id);
  child.kill('SIGTERM');
  // Give it a moment, then force kill if still running.
  setTimeout(() => {
    if (registry.has(parsed.data.id)) {
      child.kill('SIGKILL');
    }
  }, 3000);
  return c.json({ ok: true });
});

/**
 * HS-8040 — kill every shell-command process currently tracked. Called
 * from `gracefulShutdown` so custom-command buttons (`target: 'shell'`)
 * don't leave orphaned children after Hot Sheet exits.
 *
 * Sends SIGTERM to everything, waits up to `gracePeriodMs` for the
 * children to exit cleanly (their `'close'` handlers fire and `release`
 * themselves from the registry + write the final log entry), then
 * SIGKILLs anything still alive. Resolves after the grace period whether
 * or not every child has actually exited — the shutdown pipeline can't
 * block on a misbehaving process.
 *
 * Marks each id as killed so the `'close'` handler surfaces "Canceled"
 * in the command log instead of "Killed by SIGTERM".
 */
export async function killAllRunningShellCommands(
  opts: { gracePeriodMs?: number } = {},
): Promise<{ killed: number }> {
  const gracePeriodMs = opts.gracePeriodMs ?? 1000;
  const ids = registry.runningIds();
  if (ids.length === 0) return { killed: 0 };

  for (const id of ids) {
    const child = registry.get(id);
    if (child === undefined) continue;
    registry.markKilled(id);
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
  }

  await new Promise<void>(resolve => setTimeout(resolve, gracePeriodMs));

  for (const id of ids) {
    const child = registry.get(id);
    if (child === undefined) continue;
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
  }

  return { killed: ids.length };
}

/** HS-8040 — test-only inspection of the running-processes count. The
 *  registry itself stays module-private so tests can't accidentally mutate it.
 */
export function _runningShellCommandCountForTesting(): number {
  return registry.size();
}

shellRoutes.get('/shell/running', (c) => {
  const ids = registry.runningIds();
  // HS-7982 Phase 2 — extend the response with the per-id partial buffer
  // so a polling client (today, the existing 2 s `setInterval` poll in
  // `commandSidebar.tsx::startShellPoll`) gets the latest accumulated
  // output without a separate request. Backwards-compatible — clients
  // that ignore `outputs` continue to work.
  const outputs: Record<number, string> = {};
  for (const id of ids) {
    const partial = registry.partial(id);
    if (partial !== undefined) outputs[id] = partial;
  }
  return c.json({ ids, outputs });
});
