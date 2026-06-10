// @vitest-environment happy-dom
//
// HS-8804 — the announcer session persistence: save/load/clear round-trip
// (localStorage), tolerance of corrupt/absent data, and the pure
// `resolveRestoreIndex` helper that maps a saved entry back to a reel index.
import { beforeEach, describe, expect, it } from 'vitest';

import {
  type AnnouncerSession, clearAnnouncerSession, firstUnlistenedIndex, loadAnnouncerSession,
  resolveRestoreIndex, saveAnnouncerSession,
} from './announcerSession.js';

const SESSION: AnnouncerSession = {
  context: 'proj-a',
  entryId: 42,
  entryProjectSecret: 'proj-a',
  playing: true,
  minimized: false,
};

describe('announcer session persistence (HS-8804)', () => {
  beforeEach(() => { window.localStorage.clear(); });

  it('round-trips a saved session', () => {
    saveAnnouncerSession(SESSION);
    expect(loadAnnouncerSession()).toEqual(SESSION);
  });

  it('returns null when nothing is saved', () => {
    expect(loadAnnouncerSession()).toBeNull();
  });

  it('clear removes the saved session', () => {
    saveAnnouncerSession(SESSION);
    clearAnnouncerSession();
    expect(loadAnnouncerSession()).toBeNull();
  });

  it('returns null (not throw) for corrupt JSON', () => {
    window.localStorage.setItem('hotsheet:announcer-session', '{not valid json');
    expect(loadAnnouncerSession()).toBeNull();
  });

  it('returns null for a shape-mismatched payload', () => {
    window.localStorage.setItem('hotsheet:announcer-session', JSON.stringify({ context: 'x', playing: 'yes' }));
    expect(loadAnnouncerSession()).toBeNull();
  });

  it('round-trips the All Projects / empty-reel shape (null entry)', () => {
    const s: AnnouncerSession = { context: 'all', entryId: null, entryProjectSecret: null, playing: false, minimized: true };
    saveAnnouncerSession(s);
    expect(loadAnnouncerSession()).toEqual(s);
  });
});

describe('resolveRestoreIndex (HS-8804)', () => {
  const reel = [
    { id: 10, projectSecret: 'a' },
    { id: 20, projectSecret: 'a' },
    { id: 10, projectSecret: 'b' }, // same id, different project (All Projects)
  ];

  it('finds the saved entry by id + owning project', () => {
    expect(resolveRestoreIndex(reel, { entryId: 20, entryProjectSecret: 'a' })).toBe(1);
  });

  it('disambiguates colliding ids across projects', () => {
    expect(resolveRestoreIndex(reel, { entryId: 10, entryProjectSecret: 'b' })).toBe(2);
    expect(resolveRestoreIndex(reel, { entryId: 10, entryProjectSecret: 'a' })).toBe(0);
  });

  it('falls back to the first entry when the saved one is gone (dismissed / filtered)', () => {
    expect(resolveRestoreIndex(reel, { entryId: 999, entryProjectSecret: 'a' })).toBe(0);
  });

  it('falls back to the first entry when no entry was saved', () => {
    expect(resolveRestoreIndex(reel, { entryId: null, entryProjectSecret: null })).toBe(0);
  });

  it('returns -1 for an empty reel', () => {
    expect(resolveRestoreIndex([], { entryId: 10, entryProjectSecret: 'a' })).toBe(-1);
  });

  it('matches on id alone when the saved project is null (legacy/global)', () => {
    expect(resolveRestoreIndex(reel, { entryId: 20, entryProjectSecret: null })).toBe(1);
  });
});

describe('firstUnlistenedIndex (HS-8803)', () => {
  it('returns 0 for an empty reel', () => {
    expect(firstUnlistenedIndex([])).toBe(0);
  });

  it('starts on the first never-heard entry', () => {
    const reel = [
      { listened_at: '2026-06-07T00:00:00.000Z' },
      { listened_at: '2026-06-07T00:10:00.000Z' },
      { listened_at: null },
      { listened_at: null },
    ];
    expect(firstUnlistenedIndex(reel)).toBe(2);
  });

  it('starts at 0 when nothing has been heard', () => {
    expect(firstUnlistenedIndex([{ listened_at: null }, { listened_at: null }])).toBe(0);
  });

  it('starts on the last entry when everything is already heard (within grace)', () => {
    const reel = [
      { listened_at: '2026-06-07T00:00:00.000Z' },
      { listened_at: '2026-06-07T00:10:00.000Z' },
    ];
    expect(firstUnlistenedIndex(reel)).toBe(1);
  });
});
