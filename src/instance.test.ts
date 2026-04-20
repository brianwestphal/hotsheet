import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { tmpdir } = os;

// Mock homedir to isolate instance file from real home
const tempHome = join(tmpdir(), `hs-instance-test-${Date.now()}`);
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => tempHome };
});

const {
  writeInstanceFile,
  readInstanceFile,
  removeInstanceFile,
  isInstanceRunning,
  cleanupStaleInstance,
} = await import('./instance.js');

const instanceDir = join(tempHome, '.hotsheet');
const instancePath = join(instanceDir, 'instance.json');

beforeAll(() => {
  mkdirSync(instanceDir, { recursive: true });
});

afterAll(() => {
  try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  // Clean instance file between tests
  try { rmSync(instancePath, { force: true }); } catch { /* ignore */ }
});

describe('writeInstanceFile', () => {
  it('writes correct JSON with port and PID', () => {
    writeInstanceFile(4174);
    expect(existsSync(instancePath)).toBe(true);
    const data = JSON.parse(readFileSync(instancePath, 'utf-8'));
    expect(data.port).toBe(4174);
    expect(data.pid).toBe(process.pid);
  });

  it('creates the .hotsheet directory if it does not exist', () => {
    rmSync(instanceDir, { recursive: true, force: true });
    writeInstanceFile(5000);
    expect(existsSync(instancePath)).toBe(true);
    // Restore dir for other tests
  });
});

describe('readInstanceFile', () => {
  it('returns null when file does not exist', () => {
    expect(readInstanceFile()).toBeNull();
  });

  it('returns parsed data when file exists with valid JSON', () => {
    writeFileSync(instancePath, JSON.stringify({ port: 4174, pid: 12345 }));
    const result = readInstanceFile();
    expect(result).toEqual({ port: 4174, pid: 12345 });
  });

  it('returns null for invalid JSON', () => {
    writeFileSync(instancePath, 'not json at all');
    expect(readInstanceFile()).toBeNull();
  });

  it('returns null for valid JSON missing required fields', () => {
    writeFileSync(instancePath, JSON.stringify({ port: 4174 }));
    expect(readInstanceFile()).toBeNull();
  });

  it('returns null for valid JSON with wrong types', () => {
    writeFileSync(instancePath, JSON.stringify({ port: 'abc', pid: 'xyz' }));
    expect(readInstanceFile()).toBeNull();
  });
});

describe('removeInstanceFile', () => {
  it('removes file when PID matches current process', () => {
    writeInstanceFile(4174); // writes with process.pid
    expect(existsSync(instancePath)).toBe(true);
    removeInstanceFile();
    expect(existsSync(instancePath)).toBe(false);
  });

  it('does not remove file when PID does not match', () => {
    writeFileSync(instancePath, JSON.stringify({ port: 4174, pid: 99999999 }));
    removeInstanceFile();
    expect(existsSync(instancePath)).toBe(true);
  });

  it('does nothing when file does not exist', () => {
    // Should not throw
    expect(() => removeInstanceFile()).not.toThrow();
  });
});

describe('isInstanceRunning', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns true when fetch returns 200', async () => {
    globalThis.fetch = (async () => ({ status: 200 })) as unknown as typeof fetch;
    expect(await isInstanceRunning(4174)).toBe(true);
  });

  it('returns false when fetch returns non-200', async () => {
    globalThis.fetch = (async () => ({ status: 500 })) as unknown as typeof fetch;
    expect(await isInstanceRunning(4174)).toBe(false);
  });

  it('returns false on connection error', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await isInstanceRunning(4174)).toBe(false);
  });
});

describe('cleanupStaleInstance', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns false when no instance file exists', async () => {
    expect(await cleanupStaleInstance()).toBe(false);
  });

  it('returns false for a legitimate running instance (PID alive + port active)', async () => {
    // Use current process PID (known to be alive)
    writeFileSync(instancePath, JSON.stringify({ port: 4174, pid: process.pid }));
    globalThis.fetch = (async () => ({ status: 200 })) as unknown as typeof fetch;

    expect(await cleanupStaleInstance()).toBe(false);
    // Instance file should still exist
    expect(existsSync(instancePath)).toBe(true);
  });

  it('cleans up when PID is dead and port is not active', async () => {
    // Use a PID that is almost certainly not alive
    writeFileSync(instancePath, JSON.stringify({ port: 4174, pid: 2147483647 }));
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;

    const result = await cleanupStaleInstance();
    expect(result).toBe(true);
    expect(existsSync(instancePath)).toBe(false);
  });

  it('attempts shutdown and cleans up when PID is dead but port is active (orphaned server)', async () => {
    writeFileSync(instancePath, JSON.stringify({ port: 4174, pid: 2147483647 }));

    const fetchCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push(url);
      return { status: 200 };
    }) as unknown as typeof fetch;

    const result = await cleanupStaleInstance();
    expect(result).toBe(true);
    expect(existsSync(instancePath)).toBe(false);
    // Should have called both /api/projects (isInstanceRunning) and /api/shutdown
    expect(fetchCalls.some(u => u.includes('/api/projects'))).toBe(true);
    expect(fetchCalls.some(u => u.includes('/api/shutdown'))).toBe(true);
  });
});
