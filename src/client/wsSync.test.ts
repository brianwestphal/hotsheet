import { describe, expect, it, vi } from 'vitest';

import { backoffDelay, createWsSync, frameAction, shouldFallback, type WsLike } from './wsSync.js';

describe('backoffDelay', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect(backoffDelay(0)).toBe(1000);
    expect(backoffDelay(1)).toBe(2000);
    expect(backoffDelay(2)).toBe(4000);
    expect(backoffDelay(5)).toBe(30000); // 32000 capped
    expect(backoffDelay(10)).toBe(30000);
  });
});

describe('shouldFallback', () => {
  it('fires on 2 drops within 30s, not on 1', () => {
    expect(shouldFallback([1000], 1000)).toBe(false);
    expect(shouldFallback([1000, 2000], 2000)).toBe(true);
  });
  it('ignores drops older than the 30s window', () => {
    expect(shouldFallback([1000, 40000], 40000)).toBe(false); // 1000 is >30s ago
  });
});

describe('frameAction', () => {
  it('classifies frames', () => {
    expect(frameAction('ping')).toBe('pong');
    expect(frameAction('connected')).toBe('connected');
    expect(frameAction('resync')).toBe('resync');
    expect(frameAction('attachment-added')).toBe('detail');
    expect(frameAction('attachment-deleted')).toBe('detail');
    expect(frameAction('ticket-updated')).toBe('data');
    expect(frameAction('batch-operation')).toBe('data');
    expect(frameAction('settings-changed')).toBe('data');
    expect(frameAction('pong')).toBe('ignore');
    expect(frameAction('whatever')).toBe('ignore');
  });
});

class FakeSocket implements WsLike {
  sent: string[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; }
  /** Simulate the server pushing a frame. */
  push(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

function harness(initialSecret: string | null = 'sec') {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const timers: Array<() => void> = [];
  let now = 0;
  let secret = initialSecret;
  const refreshData = vi.fn();
  const refreshDetail = vi.fn();
  const refreshClaims = vi.fn();
  const showHint = vi.fn();
  const ws = createWsSync({
    createSocket: (url) => { urls.push(url); const s = new FakeSocket(); sockets.push(s); return s; },
    now: () => now,
    setTimer: (fn) => { timers.push(fn); return timers.length - 1; },
    clearTimer: () => { /* no-op for the test */ },
    refreshData,
    refreshDetail,
    refreshClaims,
    showHint,
    getSecret: () => secret,
    buildUrl: (s, since) => `ws://x/ws/sync?project=${s}${since !== undefined ? `&since=${since}` : ''}`,
  });
  return {
    ws, sockets, urls, refreshData, refreshDetail, refreshClaims, showHint,
    last: () => sockets[sockets.length - 1],
    runTimers: () => { const pending = timers.splice(0); for (const t of pending) t(); },
    setNow: (n: number) => { now = n; },
    setSecret: (s: string | null) => { secret = s; },
  };
}

describe('createWsSync flow', () => {
  it('connects on start and goes active on the connected frame', () => {
    const h = harness();
    h.ws.start();
    expect(h.sockets).toHaveLength(1);
    expect(h.urls[0]).toBe('ws://x/ws/sync?project=sec'); // no since on first connect
    expect(h.ws.isActive()).toBe(false);
    h.last().push({ type: 'connected', seq: 7 });
    expect(h.ws.isActive()).toBe(true);
  });

  it('does not connect when there is no active project secret', () => {
    const h = harness(null);
    h.ws.start();
    expect(h.sockets).toHaveLength(0);
  });

  it('replies pong to ping', () => {
    const h = harness();
    h.ws.start();
    h.last().push({ type: 'ping' });
    expect(h.last().sent).toEqual([JSON.stringify({ type: 'pong' })]);
  });

  it('refreshes data on a mutation event and dedups by seq', () => {
    const h = harness();
    h.ws.start();
    h.last().push({ type: 'connected', seq: 5 });
    h.last().push({ type: 'ticket-updated', id: 1, changes: {}, seq: 5 }); // <= baseline → ignored
    expect(h.refreshData).not.toHaveBeenCalled();
    h.last().push({ type: 'ticket-updated', id: 1, changes: {}, seq: 6 });
    expect(h.refreshData).toHaveBeenCalledTimes(1);
    h.last().push({ type: 'ticket-deleted', id: 2, seq: 7 });
    expect(h.refreshData).toHaveBeenCalledTimes(2);
  });

  it('refreshes only the detail panel on attachment events', () => {
    const h = harness();
    h.ws.start();
    h.last().push({ type: 'attachment-added', ticketId: 1, attachment: {}, seq: 1 });
    expect(h.refreshDetail).toHaveBeenCalledTimes(1);
    expect(h.refreshData).not.toHaveBeenCalled();
  });

  it('refreshes only the claim set on a claims-changed event (HS-8973)', () => {
    const h = harness();
    h.ws.start();
    h.last().push({ type: 'claims-changed', seq: 1 });
    expect(h.refreshClaims).toHaveBeenCalledTimes(1);
    expect(h.refreshData).not.toHaveBeenCalled();
    expect(h.refreshDetail).not.toHaveBeenCalled();
  });

  it('does a full refresh on resync', () => {
    const h = harness();
    h.ws.start();
    h.last().push({ type: 'resync' });
    expect(h.refreshData).toHaveBeenCalledTimes(1);
  });

  it('reconnects with ?since after a drop and shows the hint on a double-drop', () => {
    const h = harness();
    h.ws.start();
    h.last().push({ type: 'connected', seq: 9 });
    h.last().push({ type: 'ticket-updated', id: 1, changes: {}, seq: 10 });

    // First drop — reconnect scheduled, no hint yet.
    h.last().onclose?.();
    expect(h.ws.isActive()).toBe(false);
    expect(h.showHint).not.toHaveBeenCalled();
    h.runTimers(); // fire the reconnect
    expect(h.sockets).toHaveLength(2);
    expect(h.urls[1]).toBe('ws://x/ws/sync?project=sec&since=10'); // resumes from lastSeq

    // Second drop within the window — fall back + show the hint.
    h.last().onclose?.();
    expect(h.showHint).toHaveBeenCalledWith(true);

    // Reconnect succeeds → hint cleared, active again.
    h.runTimers();
    h.last().push({ type: 'connected', seq: 20 });
    expect(h.ws.isActive()).toBe(true);
    expect(h.showHint).toHaveBeenLastCalledWith(false);
  });

  it('reconnectForActiveProject is a no-op when the secret is unchanged', () => {
    const h = harness();
    h.ws.start();
    h.last().push({ type: 'connected', seq: 9 });
    h.ws.reconnectForActiveProject();
    expect(h.sockets).toHaveLength(1); // already on this project
  });

  it('reconnectForActiveProject tears down and reconnects fresh on a project switch', () => {
    const h = harness();
    h.ws.start();
    h.last().push({ type: 'connected', seq: 9 });
    h.last().push({ type: 'ticket-updated', id: 1, changes: {}, seq: 10 });
    h.setSecret('sec2');
    h.ws.reconnectForActiveProject();
    // A new socket for the new project, since reset (different per-project seq line).
    expect(h.sockets).toHaveLength(2);
    expect(h.urls[1]).toBe('ws://x/ws/sync?project=sec2');
    expect(h.ws.isActive()).toBe(false); // awaits the new connected frame
  });

  it('stop() prevents further reconnects', () => {
    const h = harness();
    h.ws.start();
    h.ws.stop();
    h.last().onclose?.();
    h.runTimers();
    expect(h.sockets).toHaveLength(1); // no reconnect after stop
  });
});
