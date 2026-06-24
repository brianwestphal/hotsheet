import { describe, expect, it, vi } from 'vitest';

import { backoffDelay, createWsSync, frameAction, reduceMutation, shouldFallback, type WsLike } from './wsSync.js';

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

describe('reduceMutation', () => {
  const allLoaded = () => true;
  const noneLoaded = () => false;

  it('ticket-deleted → remove (always, regardless of loaded)', () => {
    expect(reduceMutation({ type: 'ticket-deleted', id: 3 }, noneLoaded)).toEqual({ remove: [3], optimistic: [], refetch: false });
  });

  it('ticket-updated → optimistic when loaded, refetch when not', () => {
    expect(reduceMutation({ type: 'ticket-updated', id: 1, changes: { title: 't' } }, allLoaded))
      .toEqual({ remove: [], optimistic: [{ id: 1, patch: { title: 't' } }], refetch: false });
    expect(reduceMutation({ type: 'ticket-updated', id: 1, changes: { title: 't' } }, noneLoaded).refetch).toBe(true);
  });

  it('field-changed events → per-id optimistic patches (loaded)', () => {
    expect(reduceMutation({ type: 'status-changed', ticketIds: [1, 2], to: 'started' }, allLoaded))
      .toEqual({ remove: [], optimistic: [{ id: 1, patch: { status: 'started' } }, { id: 2, patch: { status: 'started' } }], refetch: false });
    expect(reduceMutation({ type: 'category-changed', ticketIds: [1], to: 'bug' }, allLoaded).optimistic[0]).toEqual({ id: 1, patch: { category: 'bug' } });
    // any unloaded id → refetch
    expect(reduceMutation({ type: 'priority-changed', ticketIds: [1, 99], to: 'high' }, (id) => id === 1).refetch).toBe(true);
  });

  it('batch-operation delete/empty-trash → remove; up_next → optimistic; restore → refetch', () => {
    expect(reduceMutation({ type: 'batch-operation', op: 'delete', ids: [1, 2], changes: {} }, noneLoaded)).toEqual({ remove: [1, 2], optimistic: [], refetch: false });
    expect(reduceMutation({ type: 'batch-operation', op: 'empty-trash', ids: [4], changes: {} }, noneLoaded).remove).toEqual([4]);
    expect(reduceMutation({ type: 'batch-operation', op: 'up_next', ids: [1], changes: { up_next: true } }, allLoaded).optimistic[0]).toEqual({ id: 1, patch: { up_next: true } });
    expect(reduceMutation({ type: 'batch-operation', op: 'restore', ids: [1], changes: {} }, allLoaded).refetch).toBe(true);
  });

  it('ticket-created / settings-changed / unknown → refetch', () => {
    expect(reduceMutation({ type: 'ticket-created', ticket: { id: 1 } }, allLoaded).refetch).toBe(true);
    expect(reduceMutation({ type: 'settings-changed', key: 'k', value: 1 }, allLoaded).refetch).toBe(true);
    expect(reduceMutation({ type: 'whatever' }, allLoaded).refetch).toBe(true);
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

function harness(initialSecret: string | null = 'sec', loadedIds: number[] = []) {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const timers: Array<() => void> = [];
  let now = 0;
  let secret = initialSecret;
  const refreshData = vi.fn();
  const refreshDetail = vi.fn();
  const refreshClaims = vi.fn();
  const removeTicket = vi.fn();
  const optimisticUpdate = vi.fn();
  const showHint = vi.fn();
  const loaded = new Set<number>(loadedIds);
  const ws = createWsSync({
    createSocket: (url) => { urls.push(url); const s = new FakeSocket(); sockets.push(s); return s; },
    now: () => now,
    setTimer: (fn) => { timers.push(fn); return timers.length - 1; },
    clearTimer: () => { /* no-op for the test */ },
    refreshData,
    refreshDetail,
    refreshClaims,
    hasTicket: (id) => loaded.has(id),
    removeTicket,
    optimisticUpdate,
    showHint,
    getSecret: () => secret,
    buildUrl: (s, since) => `ws://x/ws/sync?project=${s}${since !== undefined ? `&since=${since}` : ''}`,
  });
  return {
    ws, sockets, urls, refreshData, refreshDetail, refreshClaims, removeTicket, optimisticUpdate, showHint,
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

  it('dedups by seq (a seq <= the connected baseline is ignored)', () => {
    const h = harness();
    h.ws.start();
    h.last().push({ type: 'connected', seq: 5 });
    h.last().push({ type: 'ticket-updated', id: 1, changes: {}, seq: 5 }); // <= baseline → ignored
    expect(h.refreshData).not.toHaveBeenCalled();
    expect(h.optimisticUpdate).not.toHaveBeenCalled();
    h.last().push({ type: 'ticket-updated', id: 1, changes: { title: 'x' }, seq: 6 }); // id 1 not loaded → refetch
    expect(h.refreshData).toHaveBeenCalledTimes(1);
  });

  it('applies a loaded ticket in place (optimisticUpdate, no refetch)', () => {
    const h = harness('sec', [1]);
    h.ws.start();
    h.last().push({ type: 'connected', seq: 0 });
    h.last().push({ type: 'ticket-updated', id: 1, changes: { title: 'renamed' }, seq: 1 });
    expect(h.optimisticUpdate).toHaveBeenCalledWith(1, { title: 'renamed' });
    expect(h.refreshData).not.toHaveBeenCalled();
  });

  it('refetches when an affected ticket is NOT loaded (it may now be in-view)', () => {
    const h = harness('sec', []);
    h.ws.start();
    h.last().push({ type: 'connected', seq: 0 });
    h.last().push({ type: 'status-changed', ticketIds: [9], to: 'started', seq: 1 });
    expect(h.refreshData).toHaveBeenCalledTimes(1);
    expect(h.optimisticUpdate).not.toHaveBeenCalled();
  });

  it('removes a deleted ticket in place (no refetch)', () => {
    const h = harness('sec', [2]);
    h.ws.start();
    h.last().push({ type: 'connected', seq: 0 });
    h.last().push({ type: 'ticket-deleted', id: 2, seq: 1 });
    expect(h.removeTicket).toHaveBeenCalledWith(2);
    expect(h.refreshData).not.toHaveBeenCalled();
  });

  it('refetches placement-sensitive events (ticket-created)', () => {
    const h = harness('sec', [1]);
    h.ws.start();
    h.last().push({ type: 'connected', seq: 0 });
    h.last().push({ type: 'ticket-created', ticket: { id: 5 }, seq: 1 });
    expect(h.refreshData).toHaveBeenCalledTimes(1);
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
