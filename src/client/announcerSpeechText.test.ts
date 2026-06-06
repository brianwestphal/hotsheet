// @vitest-environment happy-dom
/**
 * §78 Announcer (HS-8782) — the spoken-text mapping for "All Projects" mode.
 *
 * In "All Projects" the visual project chip isn't audible, so the narration
 * must reiterate the owning project name. `reelSpeechText` is the pure mapping
 * the PIP feeds to the player's `speechTextFor` hook.
 */
import { describe, expect, it } from 'vitest';

import { ALL_PROJECTS, type ReelEntry, reelSpeechText } from './announcerPip.js';

function reelEntry(over: Partial<ReelEntry> = {}): ReelEntry {
  return {
    id: 1, created_at: '', covers_from: null, covers_to: null,
    title: 'T', script: 'did the thing', emphasis: [], visuals: [],
    position: 1, dismissed: false,
    projectSecret: 'sec', projectName: 'Hot Sheet',
    ...over,
  };
}

describe('reelSpeechText (HS-8782)', () => {
  it('prepends the project name in All Projects mode', () => {
    expect(reelSpeechText(reelEntry(), ALL_PROJECTS)).toBe('In Hot Sheet: did the thing');
  });

  it('does NOT prepend in a single-project context', () => {
    expect(reelSpeechText(reelEntry(), 'sec')).toBe('did the thing');
  });

  it('falls back to the raw script when the project name is blank', () => {
    expect(reelSpeechText(reelEntry({ projectName: '   ' }), ALL_PROJECTS)).toBe('did the thing');
  });

  it('uses the entry-specific project name (interleaved reel)', () => {
    expect(reelSpeechText(reelEntry({ projectName: 'Glassbox', script: 'shipped X' }), ALL_PROJECTS))
      .toBe('In Glassbox: shipped X');
  });
});
