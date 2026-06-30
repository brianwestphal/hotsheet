import { StringDecoder } from 'node:string_decoder';

import { type ChildProcess, spawn } from 'child_process';
import { Hono } from 'hono';

import { addLogEntry, updateLogEntry } from '../db/commandLog.js';
import type { AppEnv } from '../types.js';
import { notifyChange } from './notify.js';
import { parseBody, ShellExecSchema, ShellKillSchema } from './validation.js';

export const shellRoutes = new Hono<AppEnv>();

/**
 * HS-8549 — `ShellProcessRegistry` owns the module-level Maps that pre-fix were
 * juggled by hand across every spawn / kill / close path. Each lifecycle event
 * now calls exactly one method, which keeps the "remember to clear killedProcesses
 * on close" coordination invariant readable in one place.
 *
 *   - `register(logId, child)` — tracks a freshly-spawned child.
 *   - `markKilled(logId)` — adds to the killed set so the close handler
 *      can surface "Canceled" instead of "Killed by SIGTERM".
 *   - `wasKilled(logId)` — read-then-clear (close handler consumes).
 *   - `release(logId)` — removes from `running`. Called from `close` AND `error`.
 *   - `get(logId)` — peek the live ChildProcess (kill route + grace timer).
 *   - `runningIds()` — snapshot for `/shell/running` + shutdown.
 *   - `size()` — count for `_runningShellCommandCountForTesting`.
 *
 * The Maps are private; nothing outside this module mutates them.
 */
class ShellProcessRegistry {
  private readonly running = new Map<number, ChildProcess>();
  private readonly killed = new Set<number>();

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
  release(logId: number): void {
    this.running.delete(logId);
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
 * chunk-boundary safety) into the FINAL output, then `close` writes the
 * final log entry + notifies long-poll waiters, `error` does the same with
 * a spawn-error summary.
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
    stdout += stdoutDecoder.write(data);
  });
  child.stderr.on('data', (data: Buffer) => {
    stderr += stderrDecoder.write(data);
  });

  child.on('close', (code, signal) => {
    const wasCanceled = registry.wasKilled(logId);
    // HS-8557 — flush trailing buffered bytes so an incomplete UTF-8
    // sequence interrupted by the process closing mid-character gets
    // emitted as a single replacement char rather than silently
    // dropped. `.end()` returns the flushed string ('' when empty).
    stdout += stdoutDecoder.end();
    stderr += stderrDecoder.end();
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
  // The running ids drive the client's completion detection + busy spinner
  // (`commandSidebar.tsx::startShellPoll`) and the `isRunningShell` annotation
  // (`commandLog.tsx`). Final output is written to the log entry on close.
  return c.json({ ids: registry.runningIds() });
});
