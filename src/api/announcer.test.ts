/**
 * HS-8745 — announcer typed-API callers + wire schemas. Stubs the JSON
 * transport and asserts each caller's path / method / body, plus the request
 * schemas' validation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiCallOpts, type ApiTransport, setApiTransport } from './_runner.js';
import {
  advanceAnnouncerCursor, AnnouncementSchema, clearAnnouncements, dismissAnnouncement,
  generateAnnouncements, getAnnouncerEntries, getAnnouncerStatus,
  selectAnnouncerKey, SelectAnnouncerKeyReqSchema,
  setAnnouncerEnabled, SetAnnouncerEnabledReqSchema,
} from './announcer.js';

let lastCall: { path: string; opts: ApiCallOpts } | undefined;
function stub(result: unknown): void {
  setApiTransport(vi.fn<ApiTransport>((path, opts) => { lastCall = { path, opts }; return Promise.resolve(result); }));
}

afterEach(() => { setApiTransport(null as unknown as ApiTransport); lastCall = undefined; });

const sampleEntry = {
  id: 1, created_at: '2026-06-05T00:00:00Z', covers_from: null, covers_to: '2026-06-05T01:00:00Z',
  title: 'T', script: 'S', position: 1, dismissed: false,
};

describe('announcer schemas (HS-8745)', () => {
  it('AnnouncementSchema accepts a row and tolerates extra columns', () => {
    expect(AnnouncementSchema.safeParse(sampleEntry).success).toBe(true);
    expect(AnnouncementSchema.safeParse({ ...sampleEntry, extra: 1 }).success).toBe(true);
    expect(AnnouncementSchema.safeParse({ ...sampleEntry, id: 'x' }).success).toBe(false);
  });
  it('request schemas validate', () => {
    expect(SelectAnnouncerKeyReqSchema.safeParse({ keyId: 'abc' }).success).toBe(true);
    expect(SelectAnnouncerKeyReqSchema.safeParse({ keyId: null }).success).toBe(true);
    expect(SelectAnnouncerKeyReqSchema.safeParse({ keyId: 5 }).success).toBe(false);
    expect(SetAnnouncerEnabledReqSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(SetAnnouncerEnabledReqSchema.safeParse({ enabled: 'yes' }).success).toBe(false);
  });
});

describe('announcer callers (HS-8745)', () => {
  it('getAnnouncerStatus → GET /announcer/status', async () => {
    stub({ enabled: true, hasKey: false, selectedKeyId: null, entryCount: 2, lastListenedAt: null });
    expect((await getAnnouncerStatus()).entryCount).toBe(2);
    expect(lastCall).toEqual({ path: '/announcer/status', opts: {} });
  });

  it('generateAnnouncements → POST /announcer/generate with body', async () => {
    stub({ entries: [sampleEntry], generated: 1 });
    const res = await generateAnnouncements({ since: '2026-06-05T00:00:00Z' });
    expect(res.generated).toBe(1);
    expect(lastCall).toEqual({ path: '/announcer/generate', opts: { method: 'POST', body: { since: '2026-06-05T00:00:00Z' } } });
  });

  it('getAnnouncerEntries → GET /announcer/entries, unwraps entries', async () => {
    stub({ entries: [sampleEntry] });
    expect(await getAnnouncerEntries()).toHaveLength(1);
    expect(lastCall?.path).toBe('/announcer/entries');
  });

  it('advanceAnnouncerCursor → POST /announcer/cursor', async () => {
    stub({ ok: true });
    await advanceAnnouncerCursor('2026-06-05T02:00:00Z');
    expect(lastCall).toEqual({ path: '/announcer/cursor', opts: { method: 'POST', body: { at: '2026-06-05T02:00:00Z' } } });
  });

  it('selectAnnouncerKey → POST /announcer/key-selection', async () => {
    stub({ ok: true });
    await selectAnnouncerKey('key-id-1');
    expect(lastCall).toEqual({ path: '/announcer/key-selection', opts: { method: 'POST', body: { keyId: 'key-id-1' } } });
  });

  it('selectAnnouncerKey(null) clears the selection', async () => {
    stub({ ok: true });
    await selectAnnouncerKey(null);
    expect(lastCall).toEqual({ path: '/announcer/key-selection', opts: { method: 'POST', body: { keyId: null } } });
  });

  it('setAnnouncerEnabled → POST /announcer/enabled', async () => {
    stub({ ok: true });
    await setAnnouncerEnabled(false);
    expect(lastCall).toEqual({ path: '/announcer/enabled', opts: { method: 'POST', body: { enabled: false } } });
  });

  it('dismissAnnouncement → POST /announcer/dismiss/:id', async () => {
    stub({ ok: true });
    await dismissAnnouncement(7);
    expect(lastCall).toEqual({ path: '/announcer/dismiss/7', opts: { method: 'POST' } });
  });

  it('clearAnnouncements → POST /announcer/clear', async () => {
    stub({ ok: true });
    await clearAnnouncements();
    expect(lastCall?.path).toBe('/announcer/clear');
  });
});
