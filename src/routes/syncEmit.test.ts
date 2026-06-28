/**
 * HS-9135 — the WebSocket-push emit helper (`routes/syncEmit.ts`). `emitEvent`
 * is mocked; a fake Hono context supplies the `projectSecret` bus key.
 */
import type { Context } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SyncEventInput } from '../schemas.js';
import type { AppEnv } from '../types.js';
import { emitSync, notesToString } from './syncEmit.js';

const emitEventMock = vi.hoisted(() => vi.fn());
vi.mock('../sync/eventBus.js', () => ({ emitEvent: emitEventMock }));

function ctx(secret: string): Context<AppEnv> {
  return { get: (k: string) => (k === 'projectSecret' ? secret : undefined) } as unknown as Context<AppEnv>;
}
const input = { kind: 'ticket', action: 'detail' } as unknown as SyncEventInput;

beforeEach(() => { emitEventMock.mockReset(); });

describe('emitSync', () => {
  it('emits on the project secret bus key', () => {
    emitSync(ctx('secretXYZ'), input);
    expect(emitEventMock).toHaveBeenCalledWith('secretXYZ', input);
  });
  it('is a no-op for a blank secret (un-secured project)', () => {
    emitSync(ctx(''), input);
    expect(emitEventMock).not.toHaveBeenCalled();
  });
});

describe('notesToString', () => {
  it('passes a string through unchanged', () => {
    expect(notesToString('[{"text":"hi"}]')).toBe('[{"text":"hi"}]');
  });
  it('JSON-stringifies a non-string (array) value', () => {
    expect(notesToString([{ text: 'hi' }])).toBe('[{"text":"hi"}]');
  });
});
