// @vitest-environment happy-dom
/**
 * HS-9291 — the empty-state HERO (C) + the launch spotlight PULSE (D) for the
 * new-ticket input. `updateDraftHero` toggles the hero only on the main views
 * (open / up-next) when the list is empty; `maybePulseDraftInput` plays a one-shot
 * pulse once per app load, but never while the hero is showing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetDraftPulseForTests, maybePulseDraftInput, updateDraftHero } from './draftRow.js';
import { state } from './state.js';

function mountDraftRow(): { row: HTMLElement; entry: HTMLElement } {
  document.body.innerHTML =
    '<div id="new-ticket-host"><div class="ticket-row draft-row"><div class="draft-entry"></div></div></div>';
  const row = document.querySelector<HTMLElement>('.draft-row')!;
  const entry = document.querySelector<HTMLElement>('.draft-entry')!;
  return { row, entry };
}

describe('updateDraftHero (HS-9291 C)', () => {
  beforeEach(() => { _resetDraftPulseForTests(); });
  afterEach(() => { document.body.innerHTML = ''; });

  it('shows the hero on a main view (open / up-next) when the list is empty', () => {
    const { row } = mountDraftRow();
    state.view = 'open';
    updateDraftHero(true);
    expect(row.classList.contains('draft-row-hero')).toBe(true);

    state.view = 'up-next';
    updateDraftHero(true);
    expect(row.classList.contains('draft-row-hero')).toBe(true);
  });

  it('does NOT show the hero on a non-main view even when empty (empty category ≠ new-user moment)', () => {
    const { row } = mountDraftRow();
    for (const view of ['completed', 'backlog', 'archive', 'category:bug', 'priority:high']) {
      state.view = view;
      updateDraftHero(true);
      expect(row.classList.contains('draft-row-hero'), `view=${view}`).toBe(false);
    }
  });

  it('relaxes the hero the moment the list is non-empty', () => {
    const { row } = mountDraftRow();
    state.view = 'open';
    updateDraftHero(true);
    expect(row.classList.contains('draft-row-hero')).toBe(true);
    updateDraftHero(false); // a ticket now exists
    expect(row.classList.contains('draft-row-hero')).toBe(false);
  });

  it('no-ops when no draft row is mounted', () => {
    document.body.innerHTML = '<div id="new-ticket-host"></div>';
    state.view = 'open';
    expect(() => updateDraftHero(true)).not.toThrow();
  });
});

describe('maybePulseDraftInput (HS-9291 D)', () => {
  beforeEach(() => { _resetDraftPulseForTests(); });
  afterEach(() => { document.body.innerHTML = ''; });

  it('pulses the input once, and not again this load', () => {
    const { entry } = mountDraftRow();
    maybePulseDraftInput();
    expect(entry.classList.contains('draft-pulse')).toBe(true);

    entry.classList.remove('draft-pulse'); // simulate the animation ending
    maybePulseDraftInput();
    expect(entry.classList.contains('draft-pulse')).toBe(false); // guarded — once per load
  });

  it('does NOT pulse while the hero is showing (the hero is its own attention-draw)', () => {
    const { row, entry } = mountDraftRow();
    row.classList.add('draft-row-hero');
    maybePulseDraftInput();
    expect(entry.classList.contains('draft-pulse')).toBe(false);
  });

  it('no-ops when no draft row is mounted', () => {
    document.body.innerHTML = '<div id="new-ticket-host"></div>';
    expect(() => maybePulseDraftInput()).not.toThrow();
  });
});
