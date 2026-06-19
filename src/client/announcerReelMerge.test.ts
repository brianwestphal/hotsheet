// @vitest-environment happy-dom
/**
 * §78 Announcer (HS-8883) — merging a background-generated reel into the open
 * PIP. `newReelEntries` is the pure dedup the PIP uses to append only entries it
 * isn't already showing, keyed on owning-project + id (ids aren't unique across
 * projects). Regression guard for the "open immediately, fill in later" flow
 * that replaced the dead-end "Nothing new to announce yet" toast.
 */
import { describe, expect, it } from 'vitest';

import { newReelEntries, type ReelEntry } from './announcerPip.js';

function reelEntry(over: Partial<ReelEntry> = {}): ReelEntry {
  return {
    id: 1, created_at: '', covers_from: null, covers_to: null,
    title: 'T', script: 's', emphasis: [], visuals: [],
    position: 1, dismissed: false, listened_at: null,
    projectSecret: 'sec', projectName: 'Hot Sheet',
    ...over,
  };
}

describe('newReelEntries (HS-8883)', () => {
  it('returns all fresh entries when nothing is shown yet (empty open)', () => {
    const fresh = [reelEntry({ id: 1 }), reelEntry({ id: 2 })];
    expect(newReelEntries([], fresh)).toEqual(fresh);
  });

  it('drops entries already shown (the reloaded reel includes existing ones)', () => {
    const current = [reelEntry({ id: 1 }), reelEntry({ id: 2 })];
    const fresh = [reelEntry({ id: 1 }), reelEntry({ id: 2 }), reelEntry({ id: 3 })];
    expect(newReelEntries(current, fresh).map(e => e.id)).toEqual([3]);
  });

  it('treats the same id in different projects as distinct (cross-project)', () => {
    const current = [reelEntry({ id: 1, projectSecret: 'a' })];
    const fresh = [reelEntry({ id: 1, projectSecret: 'a' }), reelEntry({ id: 1, projectSecret: 'b' })];
    expect(newReelEntries(current, fresh).map(e => e.projectSecret)).toEqual(['b']);
  });

  it('returns nothing when generation produced no new entries', () => {
    const current = [reelEntry({ id: 1 }), reelEntry({ id: 2 })];
    expect(newReelEntries(current, [reelEntry({ id: 1 }), reelEntry({ id: 2 })])).toEqual([]);
  });

  it('preserves the order of the fresh reel', () => {
    const fresh = [reelEntry({ id: 5 }), reelEntry({ id: 3 }), reelEntry({ id: 9 })];
    expect(newReelEntries([], fresh).map(e => e.id)).toEqual([5, 3, 9]);
  });
});
