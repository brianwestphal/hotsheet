/**
 * HS-5548: unit tests for routes/shell.ts.
 * Mocks child_process.spawn to test exec, kill, and running list.
 */
import { EventEmitter } from 'events';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearLog, getLogEntries } from '../db/commandLog.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import type { AppEnv } from '../types.js';

// --- Mock spawn ---

class MockChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  pid = 12345;
  killed = false;

  kill(signal?: string) {
    this.killed = true;
    // Simulate close after kill
    if (signal === 'SIGKILL') {
      process.nextTick(() => this.emit('close', null, 'SIGKILL'));
    }
  }
}

let lastSpawnedChild: MockChildProcess;
const allSpawnedChildren: MockChildProcess[] = [];

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    lastSpawnedChild = new MockChildProcess();
    allSpawnedChildren.push(lastSpawnedChild);
    return lastSpawnedChild;
  }),
}));

vi.mock('./notify.js', () => ({
  notifyChange: vi.fn(),
}));

const { shellRoutes } = await import('./shell.js');

let tempDir: string;
let app: Hono<AppEnv>;

beforeAll(async () => {
  tempDir = await setupTestDb();
  app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('dataDir', tempDir);
    c.set('projectSecret', 'test-secret');
    await next();
  });
  app.route('/api', shellRoutes);
});

afterAll(async () => {
  await cleanupTestDb(tempDir);
});

beforeEach(async () => {
  // Close any spawned children from previous tests so runningProcesses map is clean
  for (const child of allSpawnedChildren) {
    if (!child.emit('close', 0, null)) {
      // Already closed or no listeners — that's fine
    }
  }
  allSpawnedChildren.length = 0;
  await new Promise(r => setTimeout(r, 10));
  await clearLog();
  vi.clearAllMocks();
});

function post(body: unknown) {
  return {
    method: 'POST' as const,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('POST /shell/exec', () => {
  it('spawns a process and returns a log entry ID', async () => {
    const res = await app.request('/api/shell/exec', post({ command: 'echo hello' }));
    expect(res.status).toBe(200);
    const data = await res.json() as { id: number };
    expect(data.id).toBeGreaterThan(0);
  });

  it('creates a command_log entry with the command', async () => {
    await app.request('/api/shell/exec', post({ command: 'ls -la' }));

    const entries = await getLogEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].event_type).toBe('shell_command');
    expect(entries[0].direction).toBe('outgoing');
    expect(entries[0].detail).toBe('ls -la');
  });

  it('uses name as summary when provided', async () => {
    await app.request('/api/shell/exec', post({ command: 'npm run build', name: 'Build Project' }));

    const entries = await getLogEntries();
    expect(entries[0].summary).toBe('Build Project');
  });

  it('uses truncated command as summary when name not provided', async () => {
    const longCmd = 'x'.repeat(300);
    await app.request('/api/shell/exec', post({ command: longCmd }));

    const entries = await getLogEntries();
    expect(entries[0].summary).toBe(longCmd.slice(0, 200));
  });

  it('returns 400 for empty command', async () => {
    const res = await app.request('/api/shell/exec', post({ command: '' }));
    expect(res.status).toBe(400);
  });

  it('tracks the process in running list', async () => {
    await app.request('/api/shell/exec', post({ command: 'sleep 10' }));

    const res = await app.request('/api/shell/running');
    const data = await res.json() as { ids: number[] };
    expect(data.ids.length).toBe(1);
  });

  it('updates log entry when process completes successfully', async () => {
    const execRes = await app.request('/api/shell/exec', post({ command: 'echo done' }));
    const { id } = await execRes.json() as { id: number };

    // Simulate stdout and close
    lastSpawnedChild.stdout.emit('data', Buffer.from('output text'));
    lastSpawnedChild.emit('close', 0, null);

    // Wait for async update
    await new Promise(r => setTimeout(r, 50));

    const entries = await getLogEntries();
    const entry = entries.find(e => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.summary).toContain('Completed (exit 0)');
    expect(entry!.detail).toContain('output text');
  });

  it('updates log entry with stderr on failure', async () => {
    const execRes = await app.request('/api/shell/exec', post({ command: 'bad-cmd' }));
    const { id } = await execRes.json() as { id: number };

    lastSpawnedChild.stderr.emit('data', Buffer.from('command not found'));
    lastSpawnedChild.emit('close', 127, null);

    await new Promise(r => setTimeout(r, 50));

    const entries = await getLogEntries();
    const entry = entries.find(e => e.id === id);
    expect(entry!.summary).toContain('Exited with code 127');
    expect(entry!.detail).toContain('--- stderr ---');
    expect(entry!.detail).toContain('command not found');
  });

  it('removes process from running list after close', async () => {
    await app.request('/api/shell/exec', post({ command: 'echo done' }));

    lastSpawnedChild.emit('close', 0, null);
    await new Promise(r => setTimeout(r, 50));

    const res = await app.request('/api/shell/running');
    const data = await res.json() as { ids: number[] };
    expect(data.ids.length).toBe(0);
  });

  it('handles spawn error gracefully', async () => {
    const execRes = await app.request('/api/shell/exec', post({ command: 'test-error' }));
    const { id } = await execRes.json() as { id: number };

    lastSpawnedChild.emit('error', new Error('spawn ENOENT'));

    await new Promise(r => setTimeout(r, 50));

    const entries = await getLogEntries();
    const entry = entries.find(e => e.id === id);
    expect(entry!.summary).toContain('Error: spawn ENOENT');
  });
});

describe('POST /shell/kill', () => {
  it('sends SIGTERM to a running process', async () => {
    const execRes = await app.request('/api/shell/exec', post({ command: 'sleep 60' }));
    const { id } = await execRes.json() as { id: number };

    const res = await app.request('/api/shell/kill', post({ id }));
    expect(res.status).toBe(200);
    expect(lastSpawnedChild.killed).toBe(true);
  });

  it('returns 404 for unknown process ID', async () => {
    const res = await app.request('/api/shell/kill', post({ id: 99999 }));
    expect(res.status).toBe(404);
  });

  it('marks process as canceled in log summary', async () => {
    const execRes = await app.request('/api/shell/exec', post({ command: 'sleep 60' }));
    const { id } = await execRes.json() as { id: number };

    await app.request('/api/shell/kill', post({ id }));

    // Simulate the process closing after kill
    lastSpawnedChild.emit('close', null, 'SIGTERM');
    await new Promise(r => setTimeout(r, 50));

    const entries = await getLogEntries();
    const entry = entries.find(e => e.id === id);
    expect(entry!.summary).toContain('Canceled');
  });

  it('returns 400 for invalid body', async () => {
    const res = await app.request('/api/shell/kill', post({ id: 'not-a-number' }));
    expect(res.status).toBe(400);
  });
});

describe('GET /shell/running', () => {
  it('returns empty ids when no processes running', async () => {
    const res = await app.request('/api/shell/running');
    expect(res.status).toBe(200);
    const data = await res.json() as { ids: number[]; outputs?: Record<number, string> };
    expect(data.ids).toEqual([]);
    // HS-7982 — `outputs` must always be present (even when empty) so
    // clients can rely on its existence without optional chaining gymnastics.
    expect(data.outputs).toEqual({});
  });

  it('returns IDs of all running processes', async () => {
    const res1 = await app.request('/api/shell/exec', post({ command: 'sleep 1' }));
    const res2 = await app.request('/api/shell/exec', post({ command: 'sleep 2' }));
    const id1 = ((await res1.json()) as { id: number }).id;
    const id2 = ((await res2.json()) as { id: number }).id;

    const res = await app.request('/api/shell/running');
    const data = await res.json() as { ids: number[] };
    expect(data.ids).toContain(id1);
    expect(data.ids).toContain(id2);
  });

  // HS-7982 Phase 2 — partial-output buffer surfaced via /shell/running.
  it('exposes the in-flight partial output via the `outputs` map', async () => {
    const execRes = await app.request('/api/shell/exec', post({ command: 'sleep 30' }));
    const { id } = await execRes.json() as { id: number };
    // Emit a chunk WITHOUT closing — the process is still "running" from
    // the route's perspective, so the buffer should be visible.
    lastSpawnedChild.stdout.emit('data', Buffer.from('first chunk\n'));
    lastSpawnedChild.stdout.emit('data', Buffer.from('second chunk\n'));
    lastSpawnedChild.stderr.emit('data', Buffer.from('stderr line\n'));

    const res = await app.request('/api/shell/running');
    const data = await res.json() as { ids: number[]; outputs: Record<number, string> };
    expect(data.ids).toContain(id);
    expect(data.outputs[id]).toBe('first chunk\nsecond chunk\nstderr line\n');
  });

  it('drops the partial buffer entry once the process closes', async () => {
    const execRes = await app.request('/api/shell/exec', post({ command: 'echo done' }));
    const { id } = await execRes.json() as { id: number };
    lastSpawnedChild.stdout.emit('data', Buffer.from('output text\n'));
    // Mid-run partial is visible.
    let res = await app.request('/api/shell/running');
    let data = await res.json() as { ids: number[]; outputs: Record<number, string> };
    expect(data.outputs[id]).toBe('output text\n');

    lastSpawnedChild.emit('close', 0, null);
    await new Promise(r => setTimeout(r, 50));

    res = await app.request('/api/shell/running');
    data = await res.json() as { ids: number[]; outputs: Record<number, string> };
    expect(data.ids).not.toContain(id);
    expect(data.outputs[id]).toBeUndefined();
  });
});

describe('appendPartialOutput (HS-7982)', () => {
  it('appends chunks below the cap verbatim', async () => {
    const { appendPartialOutput } = await import('./shell.js');
    expect(appendPartialOutput('', 'hello ')).toBe('hello ');
    expect(appendPartialOutput('hello ', 'world')).toBe('hello world');
  });

  it('truncates the HEAD with the [output truncated] marker when the cap is exceeded', async () => {
    const { appendPartialOutput } = await import('./shell.js');
    // Build a 3 MB string then append a 2 MB chunk → 5 MB > 4 MB cap.
    const big = 'A'.repeat(3 * 1024 * 1024);
    const more = 'B'.repeat(2 * 1024 * 1024);
    const result = appendPartialOutput(big, more);
    // Result is exactly the cap.
    expect(result.length).toBe(4 * 1024 * 1024);
    expect(result.startsWith('[output truncated]\n')).toBe(true);
    // The MOST RECENT bytes are preserved — the trailing portion of `more`
    // is at the end.
    expect(result.endsWith('B'.repeat(64))).toBe(true);
    // Some `A` content is dropped from the head.
    const truncatedAs = result.match(/A+/g)?.[0]?.length ?? 0;
    expect(truncatedAs).toBeLessThan(3 * 1024 * 1024);
  });

  it('handles a single chunk that itself exceeds the cap', async () => {
    const { appendPartialOutput } = await import('./shell.js');
    const huge = 'C'.repeat(5 * 1024 * 1024);
    const result = appendPartialOutput('', huge);
    expect(result.length).toBe(4 * 1024 * 1024);
    expect(result.startsWith('[output truncated]\n')).toBe(true);
    expect(result.endsWith('C')).toBe(true);
  });
});

// HS-8040 — graceful-shutdown path needs to terminate every running shell-
// command process so a long-running button-launched command (e.g. `npm run
// dev` fired from a custom-command shell-target button) doesn't survive
// Hot Sheet's exit. Pre-fix the `runningProcesses` map was never walked
// from any shutdown path; children outlived the parent indefinitely.
describe('killAllRunningShellCommands (HS-8040)', () => {
  it('returns {killed: 0} when no processes are running', async () => {
    const { killAllRunningShellCommands, _runningShellCommandCountForTesting } = await import('./shell.js');
    expect(_runningShellCommandCountForTesting()).toBe(0);
    const result = await killAllRunningShellCommands({ gracePeriodMs: 10 });
    expect(result.killed).toBe(0);
  });

  it('SIGTERMs every running process and counts them', async () => {
    const { killAllRunningShellCommands } = await import('./shell.js');
    await app.request('/api/shell/exec', post({ command: 'sleep 60' }));
    const childA = lastSpawnedChild;
    await app.request('/api/shell/exec', post({ command: 'sleep 60' }));
    const childB = lastSpawnedChild;

    const result = await killAllRunningShellCommands({ gracePeriodMs: 20 });

    expect(result.killed).toBe(2);
    expect(childA.killed).toBe(true);
    expect(childB.killed).toBe(true);
  });

  it('marks each killed process as canceled in the command log', async () => {
    const { killAllRunningShellCommands } = await import('./shell.js');
    const execRes = await app.request('/api/shell/exec', post({ command: 'sleep 60', name: 'long-running button' }));
    const { id } = await execRes.json() as { id: number };

    const child = lastSpawnedChild;
    // Override `kill` so neither SIGTERM nor SIGKILL auto-emits 'close'
    // through the mock's default behaviour — we want to drive the close
    // manually below, simulating the real OS flow where SIGTERM is what
    // settles the child (not the SIGKILL grace-period escalation).
    child.kill = () => { /* swallow */ };

    await killAllRunningShellCommands({ gracePeriodMs: 10 });

    // Real children fire 'close' once the kernel reaps them after
    // SIGTERM. `killedProcesses` was populated by the kill helper, so
    // the close handler should see wasCanceled=true and write "Canceled"
    // into the log summary.
    child.emit('close', null, 'SIGTERM');
    await new Promise(r => setTimeout(r, 50));

    const entries = await getLogEntries();
    const entry = entries.find(e => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.summary).toContain('Canceled');
  });

  it('falls back to SIGKILL when SIGTERM did not unwedge the child within the grace period', async () => {
    const { killAllRunningShellCommands } = await import('./shell.js');
    await app.request('/api/shell/exec', post({ command: 'sleep 60' }));
    const child = lastSpawnedChild;

    // Make `kill` capture the signal sequence WITHOUT auto-emitting close
    // (the default mock auto-closes on SIGKILL — disable that for this
    // test so we can assert the SIGKILL escalation path actually fires).
    const signals: string[] = [];
    child.kill = (sig?: string) => { signals.push(sig ?? 'SIGTERM'); };

    await killAllRunningShellCommands({ gracePeriodMs: 30 });

    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('resolves promptly even when a child never exits — does NOT block shutdown', async () => {
    const { killAllRunningShellCommands } = await import('./shell.js');
    await app.request('/api/shell/exec', post({ command: 'sleep 60' }));
    // Simulate a fully unkillable child — `kill()` is a no-op.
    lastSpawnedChild.kill = () => { /* never dies */ };

    const t0 = Date.now();
    await killAllRunningShellCommands({ gracePeriodMs: 20 });
    const elapsed = Date.now() - t0;

    // Must resolve roughly within the grace period — caller (shutdown
    // pipeline) cannot block forever on a misbehaving process.
    expect(elapsed).toBeLessThan(200);
  });
});
