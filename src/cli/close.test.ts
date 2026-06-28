/**
 * HS-9134 — coverage for the fetch-based CLI helpers in `cli/close.ts`
 * (`shutdownRunningInstance` + `handleList`). `fetch` + the instance helpers are
 * mocked. (`handleClose` / `joinRunningInstance` involve confirm prompts +
 * browser-open and are left to integration/manual coverage.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleList, shutdownRunningInstance } from './close.js';

const instance = vi.hoisted(() => ({ isInstanceRunning: vi.fn<() => Promise<boolean>>(), readInstanceFile: vi.fn() }));
vi.mock('../instance.js', () => instance);

const fetchMock = vi.fn<(...a: unknown[]) => Promise<{ ok: boolean; json: () => Promise<unknown> }>>();

beforeEach(() => {
  fetchMock.mockReset();
  instance.isInstanceRunning.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('shutdownRunningInstance', () => {
  it('POSTs /api/shutdown and resolves once the port is free', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    instance.isInstanceRunning.mockResolvedValue(false); // port already free on first poll
    await expect(shutdownRunningInstance(4174)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4174/api/shutdown', expect.objectContaining({ method: 'POST' }));
  });

  it('returns early when the server is already gone (fetch throws)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(shutdownRunningInstance(4174)).resolves.toBeUndefined();
    expect(instance.isInstanceRunning).not.toHaveBeenCalled();
  });

  it('throws if the instance never frees the port within the deadline', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    instance.isInstanceRunning.mockResolvedValue(true); // never frees
    const p = shutdownRunningInstance(4174);
    const assertion = expect(p).rejects.toThrow(/did not exit within 10s/);
    await vi.advanceTimersByTimeAsync(11_000);
    await assertion;
  });
});

describe('handleList', () => {
  it('prints each registered project', async () => {
    const logSpy = vi.spyOn(console, 'log');
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve([
      { name: 'Proj A', dataDir: '/a/.hotsheet', ticketCount: 3 },
      { name: 'Proj B', dataDir: '/b/.hotsheet', ticketCount: 0 },
    ]) });
    await handleList(4174);
    const out = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(out).toContain('Registered projects (2)');
    expect(out).toContain('Proj A');
    expect(out).toContain('/b/.hotsheet  (0 tickets)');
  });

  it('prints a friendly message when no projects are registered', async () => {
    const logSpy = vi.spyOn(console, 'log');
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    await handleList(4174);
    expect(logSpy.mock.calls.map(c => String(c[0])).join('\n')).toContain('No projects registered');
  });

  it('exits 1 when the fetch is not ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: () => Promise.resolve(null) });
    const exitMock = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`exit:${String(c)}`); }) as never);
    await expect(handleList(4174)).rejects.toThrow('exit:1');
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it('exits 1 when the response is malformed', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve([{ not: 'a project' }]) });
    const exitMock = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`exit:${String(c)}`); }) as never);
    await expect(handleList(4174)).rejects.toThrow('exit:1');
    expect(exitMock).toHaveBeenCalledWith(1);
  });
});
