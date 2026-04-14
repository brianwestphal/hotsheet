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
    stdout += data.toString();
  });

  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString();
  });

  child.on('close', (code, signal) => {
    runningProcesses.delete(logId);
    const wasCanceled = killedProcesses.has(logId);
    killedProcesses.delete(logId);
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

shellRoutes.get('/shell/running', (c) => {
  const ids = Array.from(runningProcesses.keys());
  return c.json({ ids });
});
