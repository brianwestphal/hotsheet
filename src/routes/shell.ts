import { StringDecoder } from 'node:string_decoder';

import type { ChildProcess } from 'child_process';
import { Hono } from 'hono';

import { addLogEntry, updateLogEntry } from '../db/commandLog.js';
import { PARTIAL_OUTPUT_CAP_BYTES } from '../limits.js';
import type { AppEnv } from '../types.js';
import { parseBody, ShellExecSchema, ShellKillSchema } from './validation.js';

export const shellRoutes = new Hono<AppEnv>();

/** Running shell processes keyed by their command_log entry ID.
 *  Entries are added by /shell/exec on spawn and removed by the child's
 *  'close' event handler. Entries should never accumulate — if a process
 *  exits without triggering 'close', the entry becomes stale.
 *  Modified by: /shell/exec (add), child.on('close') (remove). */
const runningProcesses = new Map<number, ChildProcess>();

/** IDs of processes the user explicitly killed via /shell/kill.
 *  Used to distinguish "Canceled" from "Killed by signal" in log summaries.
 *  Modified by: /shell/kill (add), child.on('close') (remove). */
const killedProcesses = new Set<number>();

/**
 * HS-7982 — partial-output buffer keyed on log id. Mirrors the same chunks
 * the per-stream `stdout` / `stderr` accumulators receive, but interleaved
 * in event order so a polling client sees output in roughly the same
 * sequence the user would see it in a real terminal. Cleared on
 * `child.on('close')` / `child.on('error')`.
 *
 * Capped at `PARTIAL_OUTPUT_CAP_BYTES` bytes per command — when a chatty command
 * exceeds the cap we drop the HEAD (oldest) bytes and prepend a one-line
 * `[output truncated]\n` marker so the most recent output is always
 * readable. Without the cap a single `yes` invocation could OOM the
 * server.
 *
 * See `docs/53-streaming-shell-output.md` §53.5 Phase 1.
 */
const partialOutputs = new Map<number, string>();
// HS-8558 — `PARTIAL_OUTPUT_CAP_BYTES` lives in `src/limits.ts`.
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

function recordPartialChunk(id: number, chunk: string): void {
  partialOutputs.set(id, appendPartialOutput(partialOutputs.get(id) ?? '', chunk));
}

shellRoutes.post('/shell/exec', async (c) => {
  const { spawn } = await import('child_process');
  const dataDir = c.get('dataDir');
  const raw: unknown = await c.req.json();
  const parsed = parseBody(ShellExecSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const command = parsed.data.command;
  const name = parsed.data.name;

  // The project root is the parent of the .hotsheet data dir
  const cwd = dataDir + '/..';

  // Log the outgoing shell command — use button name as summary if provided
  const summary = name !== undefined && name !== '' ? name : command.slice(0, 200);
  const logEntry = await addLogEntry('shell_command', 'outgoing', summary, command);
  const logId = logEntry.id;

  // Spawn the process
  const child = spawn(command, { shell: true, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  runningProcesses.set(logId, child);

  let stdout = '';
  let stderr = '';
  // HS-8557 — `StringDecoder` buffers incomplete multi-byte UTF-8
  // sequences across chunk boundaries. Pre-fix the handler did
  // `data.toString()` (defaults to 'utf8'), which on a chunk ending
  // mid-multi-byte-character emits a `�` replacement char + drops
  // the trailing bytes; the next chunk's leading bytes (which would
  // have completed the codepoint) are interpreted as a fresh sequence
  // and replaced too. Result: every multi-byte character that lands on
  // a chunk boundary turns into `��`. One decoder per stream
  // (stdout / stderr) since each has its own byte boundary state.
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');

  child.stdout.on('data', (data: Buffer) => {
    const chunk = stdoutDecoder.write(data);
    stdout += chunk;
    // HS-7982 — keep the partial buffer in sync with the per-stream
    // accumulator so polling clients see chunks as they arrive.
    recordPartialChunk(logId, chunk);
  });

  child.stderr.on('data', (data: Buffer) => {
    const chunk = stderrDecoder.write(data);
    stderr += chunk;
    recordPartialChunk(logId, chunk);
  });

  child.on('close', (code, signal) => {
    runningProcesses.delete(logId);
    const wasCanceled = killedProcesses.has(logId);
    killedProcesses.delete(logId);
    // HS-8557 — flush both decoders so any trailing buffered bytes
    // (typically incomplete UTF-8 sequences interrupted by the process
    // closing mid-character) get emitted as a single replacement char
    // rather than silently dropped. `.end()` returns the flushed string
    // (empty string when nothing was buffered).
    const stdoutFlush = stdoutDecoder.end();
    const stderrFlush = stderrDecoder.end();
    if (stdoutFlush.length > 0) {
      stdout += stdoutFlush;
      recordPartialChunk(logId, stdoutFlush);
    }
    if (stderrFlush.length > 0) {
      stderr += stderrFlush;
      recordPartialChunk(logId, stderrFlush);
    }
    // HS-7982 — final detail is written to the log entry below; drop the
    // streaming buffer so a long-finished command doesn't keep memory.
    partialOutputs.delete(logId);
    const output = (stdout + (stderr ? '\n--- stderr ---\n' + stderr : '')).trim();
    const exitSummary = wasCanceled ? 'Canceled'
      : code === 0 ? 'Completed (exit 0)'
      : signal !== null ? `Killed by ${signal}`
      : `Exited with code ${code ?? 'unknown'}`;
    // Update the existing shell_command entry with output appended to detail
    const combinedDetail = command + '\n---SHELL_OUTPUT---\n' + output;
    if (logId > 0) {
      const label = name !== undefined && name !== '' ? name : command.slice(0, 100);
      updateLogEntry(logId, { summary: `${label} — ${exitSummary}`, detail: combinedDetail })
        .catch((err: unknown) => { console.warn('[shell] updateLogEntry on close failed:', err); });
    } else {
      addLogEntry('shell_command', 'outgoing', exitSummary, combinedDetail)
        .catch((err: unknown) => { console.warn('[shell] addLogEntry on close failed:', err); });
    }
    // Notify the client via long-poll
    import('./notify.js').then(({ notifyChange }) => notifyChange())
      .catch((err: unknown) => { console.warn('[shell] notifyChange on close failed:', err); });
  });

  child.on('error', (err) => {
    runningProcesses.delete(logId);
    // HS-7982 — drop the partial buffer on spawn-error too; without this
    // a failed-to-spawn command would leak its (empty / partial) buffer
    // entry forever.
    partialOutputs.delete(logId);
    const combinedDetail = command + '\n---SHELL_OUTPUT---\n' + (err.stack ?? err.message);
    if (logId > 0) {
      updateLogEntry(logId, { summary: `${command.slice(0, 100)} — Error: ${err.message}`, detail: combinedDetail })
        .catch((logErr: unknown) => { console.warn('[shell] updateLogEntry on spawn-error failed:', logErr); });
    } else {
      addLogEntry('shell_command', 'outgoing', `Error: ${err.message}`, combinedDetail)
        .catch((logErr: unknown) => { console.warn('[shell] addLogEntry on spawn-error failed:', logErr); });
    }
    import('./notify.js').then(({ notifyChange }) => notifyChange())
      .catch((logErr: unknown) => { console.warn('[shell] notifyChange on spawn-error failed:', logErr); });
  });

  return c.json({ id: logId });
});

shellRoutes.post('/shell/kill', async (c) => {
  const raw: unknown = await c.req.json();
  const parsed = parseBody(ShellKillSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const child = runningProcesses.get(parsed.data.id);
  if (!child) {
    return c.json({ error: 'Process not found or already finished' }, 404);
  }
  killedProcesses.add(parsed.data.id);
  child.kill('SIGTERM');
  // Give it a moment, then force kill if still running
  setTimeout(() => {
    if (runningProcesses.has(parsed.data.id)) {
      child.kill('SIGKILL');
    }
  }, 3000);
  return c.json({ ok: true });
});

/**
 * HS-8040 — kill every shell-command process currently tracked in
 * `runningProcesses`. Called from `gracefulShutdown` so custom-command
 * buttons (`target: 'shell'`) don't leave orphaned children running after
 * Hot Sheet exits — pre-fix a long-running `npm run dev` / `tail -f log`
 * fired from a shell-target command button kept running in the background
 * indefinitely after the user quit Hot Sheet, with no way to stop it
 * other than `pkill` or rebooting.
 *
 * Sends SIGTERM to everything, waits up to `gracePeriodMs` for the
 * children to exit cleanly (their `'close'` handlers fire and remove
 * themselves from `runningProcesses` + write the final log entry), then
 * SIGKILLs anything still alive. Resolves after the grace period whether
 * or not every child has actually exited — the shutdown pipeline can't
 * block on a misbehaving process.
 *
 * Adds each killed id to `killedProcesses` so the `'close'` handler
 * surfaces "Canceled" in the command log instead of "Killed by SIGTERM".
 */
export async function killAllRunningShellCommands(
  opts: { gracePeriodMs?: number } = {},
): Promise<{ killed: number }> {
  const gracePeriodMs = opts.gracePeriodMs ?? 1000;
  const ids = Array.from(runningProcesses.keys());
  if (ids.length === 0) return { killed: 0 };

  for (const id of ids) {
    const child = runningProcesses.get(id);
    if (child === undefined) continue;
    killedProcesses.add(id);
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
  }

  await new Promise<void>(resolve => setTimeout(resolve, gracePeriodMs));

  for (const id of ids) {
    const child = runningProcesses.get(id);
    if (child === undefined) continue;
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
  }

  return { killed: ids.length };
}

/** HS-8040 — test-only inspection of the running-processes count. The
 *  map itself stays module-private so tests can't accidentally mutate it.
 */
export function _runningShellCommandCountForTesting(): number {
  return runningProcesses.size;
}

shellRoutes.get('/shell/running', (c) => {
  const ids = Array.from(runningProcesses.keys());
  // HS-7982 Phase 2 — extend the response with the per-id partial buffer
  // so a polling client (today, the existing 2 s `setInterval` poll in
  // `commandSidebar.tsx::startShellPoll`) gets the latest accumulated
  // output without a separate request. Backwards-compatible — clients
  // that ignore `outputs` continue to work.
  const outputs: Record<number, string> = {};
  for (const id of ids) {
    const partial = partialOutputs.get(id);
    if (partial !== undefined) outputs[id] = partial;
  }
  return c.json({ ids, outputs });
});
