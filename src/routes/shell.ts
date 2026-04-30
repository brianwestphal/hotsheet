import type { ChildProcess } from 'child_process';
import { Hono } from 'hono';

import { addLogEntry, updateLogEntry } from '../db/commandLog.js';
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
 * Capped at `PARTIAL_OUTPUT_CAP` bytes per command — when a chatty command
 * exceeds the cap we drop the HEAD (oldest) bytes and prepend a one-line
 * `[output truncated]\n` marker so the most recent output is always
 * readable. Without the cap a single `yes` invocation could OOM the
 * server.
 *
 * See `docs/53-streaming-shell-output.md` §53.5 Phase 1.
 */
const partialOutputs = new Map<number, string>();
const PARTIAL_OUTPUT_CAP = 4 * 1024 * 1024;
const PARTIAL_TRUNCATION_MARKER = '[output truncated]\n';

/** Pure helper — append a chunk to the existing partial, applying the
 *  head-truncation cap. Exported for testability. */
export function appendPartialOutput(prev: string, chunk: string): string {
  const next = prev + chunk;
  if (next.length <= PARTIAL_OUTPUT_CAP) return next;
  const keep = PARTIAL_OUTPUT_CAP - PARTIAL_TRUNCATION_MARKER.length;
  return PARTIAL_TRUNCATION_MARKER + next.slice(next.length - keep);
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

  child.stdout.on('data', (data: Buffer) => {
    const chunk = data.toString();
    stdout += chunk;
    // HS-7982 — keep the partial buffer in sync with the per-stream
    // accumulator so polling clients see chunks as they arrive.
    recordPartialChunk(logId, chunk);
  });

  child.stderr.on('data', (data: Buffer) => {
    const chunk = data.toString();
    stderr += chunk;
    recordPartialChunk(logId, chunk);
  });

  child.on('close', (code, signal) => {
    runningProcesses.delete(logId);
    const wasCanceled = killedProcesses.has(logId);
    killedProcesses.delete(logId);
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
      updateLogEntry(logId, { summary: `${label} — ${exitSummary}`, detail: combinedDetail }).catch(() => {});
    } else {
      addLogEntry('shell_command', 'outgoing', exitSummary, combinedDetail).catch(() => {});
    }
    // Notify the client via long-poll
    import('./notify.js').then(({ notifyChange }) => notifyChange()).catch(() => {});
  });

  child.on('error', (err) => {
    runningProcesses.delete(logId);
    // HS-7982 — drop the partial buffer on spawn-error too; without this
    // a failed-to-spawn command would leak its (empty / partial) buffer
    // entry forever.
    partialOutputs.delete(logId);
    const combinedDetail = command + '\n---SHELL_OUTPUT---\n' + (err.stack ?? err.message);
    if (logId > 0) {
      updateLogEntry(logId, { summary: `${command.slice(0, 100)} — Error: ${err.message}`, detail: combinedDetail }).catch(() => {});
    } else {
      addLogEntry('shell_command', 'outgoing', `Error: ${err.message}`, combinedDetail).catch(() => {});
    }
    import('./notify.js').then(({ notifyChange }) => notifyChange()).catch(() => {});
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
