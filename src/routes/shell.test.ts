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
    const data = await res.json() as { ids: number[] };
    expect(data.ids).toEqual([]);
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
});
