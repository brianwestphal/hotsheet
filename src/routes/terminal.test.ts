/**
 * HS-8034 Phase 2 — tests for the new terminal-prompt endpoints
 * (`/prompt-respond`, `/prompt-dismiss`, `/prompt-resume`). Mocks the
 * registry helpers so the route logic is exercised in isolation. The
 * registry-side scanner + auto-allow gate already get their own coverage
 * via `src/terminals/promptScanner.test.ts` + `src/shared/terminalPrompt/`.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppEnv } from '../types.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const writePtyInput = vi.fn((_secret: string, _terminalId: string, _payload: string): boolean => true);
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const clearPendingPrompt = vi.fn((_secret: string, _terminalId: string): boolean => true);
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const setScannerSuppressed = vi.fn((_secret: string, _terminalId: string, _v: boolean): boolean => true);
const notifyBellWaiters = vi.fn();

vi.mock('../terminals/registry.js', () => ({
  clearBellPending: vi.fn(),
  clearPendingPrompt: (secret: string, terminalId: string) => clearPendingPrompt(secret, terminalId),
  destroyTerminal: vi.fn(),
  ensureSpawned: vi.fn(),
  getBellPending: vi.fn(),
  getCurrentCwd: vi.fn(),
  getLastOutputAtMs: vi.fn(),
  getLastSpinnerAtMs: vi.fn(),
  getNotificationMessage: vi.fn(),
  getTerminalPid: vi.fn(),
  getTerminalStatus: vi.fn(),
  killTerminal: vi.fn(),
  listProjectTerminalIds: vi.fn(),
  restartTerminal: vi.fn(),
  setScannerSuppressed: (secret: string, terminalId: string, v: boolean) => setScannerSuppressed(secret, terminalId, v),
  writePtyInput: (secret: string, terminalId: string, payload: string) => writePtyInput(secret, terminalId, payload),
}));

vi.mock('./notify.js', () => ({
  notifyBellWaiters: () => { notifyBellWaiters(); },
}));

vi.mock('../file-settings.js', () => ({
  readFileSettings: vi.fn(() => ({})),
}));

vi.mock('../terminals/processInspect.js', () => ({
  DEFAULT_EXEMPT_PROCESSES: [],
  inspectForegroundProcess: vi.fn(),
}));

vi.mock('../terminals/config.js', () => ({
  DEFAULT_TERMINAL_ID: 'default',
  listTerminalConfigs: vi.fn(() => []),
}));

const { terminalRoutes } = await import('./terminal.js');

function buildApp(secret = 'test-secret') {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('projectSecret', secret);
    c.set('dataDir', '/tmp/hs-test');
    await next();
  });
  app.route('/api/terminal', terminalRoutes);
  return app;
}

describe('POST /api/terminal/prompt-respond (HS-8034)', () => {
  beforeEach(() => {
    writePtyInput.mockClear();
    clearPendingPrompt.mockClear();
    notifyBellWaiters.mockClear();
  });
  afterEach(() => {
    writePtyInput.mockReset();
    writePtyInput.mockImplementation(() => true);
    clearPendingPrompt.mockReset();
    clearPendingPrompt.mockImplementation(() => true);
  });

  it('writes the payload to the PTY + clears pendingPrompt + notifies waiters on success', async () => {
    const app = buildApp('secret-A');
    const res = await app.request('/api/terminal/prompt-respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalId: 'default', payload: 'y\r' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(writePtyInput).toHaveBeenCalledWith('secret-A', 'default', 'y\r');
    expect(clearPendingPrompt).toHaveBeenCalledWith('secret-A', 'default');
    expect(notifyBellWaiters).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when terminalId is missing', async () => {
    const app = buildApp();
    const res = await app.request('/api/terminal/prompt-respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: 'y\r' }),
    });
    expect(res.status).toBe(400);
    expect(writePtyInput).not.toHaveBeenCalled();
  });

  it('returns 400 when payload is missing', async () => {
    const app = buildApp();
    const res = await app.request('/api/terminal/prompt-respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalId: 'default' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the PTY is dead or missing', async () => {
    writePtyInput.mockImplementation(() => false);
    const app = buildApp();
    const res = await app.request('/api/terminal/prompt-respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalId: 'default', payload: 'y\r' }),
    });
    expect(res.status).toBe(404);
    // pendingPrompt should NOT be cleared if the PTY write failed — the
    // server-side state is still authoritative.
    expect(clearPendingPrompt).not.toHaveBeenCalled();
  });
});

describe('POST /api/terminal/prompt-dismiss (HS-8034)', () => {
  beforeEach(() => {
    clearPendingPrompt.mockClear();
    setScannerSuppressed.mockClear();
    notifyBellWaiters.mockClear();
  });
  afterEach(() => {
    clearPendingPrompt.mockReset();
    clearPendingPrompt.mockImplementation(() => true);
    setScannerSuppressed.mockReset();
    setScannerSuppressed.mockImplementation(() => true);
  });

  it('clears pendingPrompt without suppressing by default', async () => {
    const app = buildApp('secret-B');
    const res = await app.request('/api/terminal/prompt-dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalId: 'default' }),
    });
    expect(res.status).toBe(200);
    expect(clearPendingPrompt).toHaveBeenCalledWith('secret-B', 'default');
    expect(setScannerSuppressed).not.toHaveBeenCalled();
    expect(notifyBellWaiters).toHaveBeenCalledTimes(1);
  });

  it('also flips scanner suppression when suppress: true', async () => {
    const app = buildApp('secret-C');
    const res = await app.request('/api/terminal/prompt-dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalId: 'default', suppress: true }),
    });
    expect(res.status).toBe(200);
    expect(clearPendingPrompt).toHaveBeenCalledWith('secret-C', 'default');
    expect(setScannerSuppressed).toHaveBeenCalledWith('secret-C', 'default', true);
  });

  it('returns 400 when terminalId is missing', async () => {
    const app = buildApp();
    const res = await app.request('/api/terminal/prompt-dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(clearPendingPrompt).not.toHaveBeenCalled();
  });
});

describe('POST /api/terminal/prompt-resume (HS-8034)', () => {
  beforeEach(() => {
    setScannerSuppressed.mockClear();
  });
  afterEach(() => {
    setScannerSuppressed.mockReset();
    setScannerSuppressed.mockImplementation(() => true);
  });

  it('clears scanner suppression for the requested terminal', async () => {
    const app = buildApp('secret-D');
    const res = await app.request('/api/terminal/prompt-resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalId: 'default' }),
    });
    expect(res.status).toBe(200);
    expect(setScannerSuppressed).toHaveBeenCalledWith('secret-D', 'default', false);
  });

  it('returns 400 when terminalId is missing', async () => {
    const app = buildApp();
    const res = await app.request('/api/terminal/prompt-resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(setScannerSuppressed).not.toHaveBeenCalled();
  });
});
