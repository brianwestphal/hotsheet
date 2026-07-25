// @vitest-environment happy-dom
//
// HS-9441 — the orphaned-overlay class: a project switch rebuilds the UI that
// hover/anchor-based overlays are anchored to, and removing an anchor fires NO
// `mouseleave` / `blur` / outside-`click`, so the overlay that those events were
// supposed to dismiss is stranded on screen showing the previous project's data.
//
// These tests simulate the real sequence — overlay up → anchor removed → switch —
// rather than calling the dismiss from a clean slate, per the transition-matrix
// guidance in CLAUDE.md's testing philosophy (a per-operation test from a clean
// state passes even with the bug present).
import { afterEach, describe, expect, it, vi } from 'vitest';

import { _resetCommandTooltipForTesting, hideCommandTooltip, showCommandTooltip } from './commandTooltip.js';
import { dismissTransientOverlays } from './transientOverlays.js';

/** An anchor that exists in the DOM, like a real command button. */
function anchor(): HTMLElement {
  const btn = document.createElement('button');
  document.body.appendChild(btn);
  return btn;
}

/** A body-appended overlay of `className`, as its owning module would mount it. */
function mountOverlay(className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  document.body.appendChild(el);
  return el;
}

const visibleTooltips = (): number =>
  document.querySelectorAll('.command-tooltip:not([hidden])').length;

describe('dismissTransientOverlays (HS-9441)', () => {
  afterEach(() => {
    _resetCommandTooltipForTesting();
    document.body.innerHTML = '';
  });

  it('hides a command tooltip whose anchor was removed without a mouseleave', () => {
    const btn = anchor();
    showCommandTooltip(btn, { name: 'Build', command: 'npm run build', lastRunIso: null });
    expect(visibleTooltips()).toBe(1);

    // The switch rebuilds the sidebar: the hovered button goes away, and the
    // browser fires NO mouseleave for a removed element — this is the bug.
    btn.remove();
    expect(visibleTooltips()).toBe(1);

    dismissTransientOverlays();
    expect(visibleTooltips()).toBe(0);
  });

  it('removes an orphaned tag-autocomplete dropdown (owner keeps its handle in a closure)', () => {
    // `bindDetailTagInput` closes this on `blur`, which a removed focused input
    // does not reliably fire — so it needs the selector backstop.
    mountOverlay('tag-autocomplete');
    dismissTransientOverlays();
    expect(document.querySelectorAll('.tag-autocomplete').length).toBe(0);
  });

  it('removes dropdown + context menus (a keyboard switch fires no outside click)', () => {
    mountOverlay('dropdown-menu');
    mountOverlay('context-menu');
    dismissTransientOverlays();
    expect(document.querySelectorAll('.dropdown-menu').length).toBe(0);
    expect(document.querySelectorAll('.context-menu').length).toBe(0);
  });

  it('leaves MODAL dialogs alone — a switch must not cancel a prompt awaiting an answer', () => {
    // The §47 permission overlay / confirm dialogs / the settings dialog are
    // dismissed by an explicit user decision, never by an anchor event. If the
    // sweep ever widened to a generic class match, this is what would break.
    const modal = mountOverlay('confirm-overlay');
    const permission = mountOverlay('permission-overlay');
    dismissTransientOverlays();
    expect(modal.isConnected).toBe(true);
    expect(permission.isConnected).toBe(true);
  });

  it('is idempotent and safe with nothing showing', () => {
    expect(() => { dismissTransientOverlays(); dismissTransientOverlays(); }).not.toThrow();
    expect(document.body.children.length).toBe(0);
  });

  it('keeps dismissing after one step throws (no half-cleaned UI)', () => {
    showCommandTooltip(anchor(), { name: 'Build', command: '', lastRunIso: null });
    mountOverlay('tag-autocomplete');
    // Force a mid-sequence failure the way a real DOM/state bug would.
    const realQuerySelectorAll = document.querySelectorAll.bind(document);
    const boom = vi.spyOn(document, 'querySelectorAll');
    let calls = 0;
    boom.mockImplementation((sel: string) => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return realQuerySelectorAll(sel);
    });
    try {
      expect(() => { dismissTransientOverlays(); }).not.toThrow();
    } finally {
      boom.mockRestore();
    }
    // The tooltip hide does not go through querySelectorAll, so it still ran.
    expect(visibleTooltips()).toBe(0);
  });

  // A→B→A walk, mirroring `projectScopedIsolation.test.ts`'s shape for the state
  // half of this class (docs/125): re-opening an overlay after a switch must work,
  // which is what a DOM-only sweep (leaving the owner's `activePopover` handle set)
  // would break — the owner would believe it is still open and refuse to reopen.
  it('an overlay shown again after a dismissal still appears (owner state was reset, not just the DOM)', () => {
    const first = anchor();
    showCommandTooltip(first, { name: 'A-project cmd', command: 'a', lastRunIso: null });
    first.remove();
    dismissTransientOverlays();
    expect(visibleTooltips()).toBe(0);

    const second = anchor();
    showCommandTooltip(second, { name: 'B-project cmd', command: 'b', lastRunIso: null });
    expect(visibleTooltips()).toBe(1);
    expect(document.querySelector('.command-tooltip-name')?.textContent).toBe('B-project cmd');

    hideCommandTooltip();
    expect(visibleTooltips()).toBe(0);
  });
});
