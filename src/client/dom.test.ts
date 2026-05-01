// @vitest-environment happy-dom
/**
 * HS-8092 — unit tests for `requireChild`. The helper replaces six
 * `root.querySelector(selector)!` non-null assertions in dialog code
 * (`feedbackDialog.tsx`, `readerOverlay.tsx`) with a typed lookup that
 * throws a descriptive error when the selector misses — so JSX-template
 * drift surfaces at the click handler's wiring time rather than as a
 * useless `Cannot read properties of null` deeper in the call stack.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { requireChild } from './dom.js';

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { document.body.innerHTML = ''; });

describe('requireChild (HS-8092)', () => {
  it('returns the element when the selector matches', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button id="ok" class="primary">click me</button>';
    const btn = requireChild<HTMLButtonElement>(root, '#ok');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.id).toBe('ok');
    // The generic constraint preserves the concrete type — `disabled`
    // would not be on the default `HTMLElement` return.
    btn.disabled = true;
    expect(btn.disabled).toBe(true);
  });

  it('returns the FIRST match for selectors that resolve multiple', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button>a</button><button>b</button>';
    expect(requireChild<HTMLButtonElement>(root, 'button').textContent).toBe('a');
  });

  it('throws with the selector + a descriptive root tag when the selector misses', () => {
    const root = document.createElement('div');
    root.id = 'feedback-overlay';
    root.className = 'permission-popup';
    root.innerHTML = '<span>nothing matching</span>';
    expect(() => requireChild(root, '#missing-id')).toThrow(/no match for "#missing-id"/);
    expect(() => requireChild(root, '#missing-id')).toThrow(/<div id="feedback-overlay" class="permission-popup">/);
  });

  it('falls back to "document" in the error message when the root is the document itself', () => {
    expect(() => requireChild(document, '#absent')).toThrow(/no match for "#absent" in document/);
  });

  it('handles unclassed / un-id-ed roots in the error message without throwing on the description build', () => {
    const root = document.createElement('section');
    expect(() => requireChild(root, '.x')).toThrow(/<section>/);
  });

  it('defaults the return type to HTMLElement when no generic is supplied', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>hi</p>';
    const el = requireChild(root, 'p');
    // Type-level assertion: `el` is `HTMLElement` so this access compiles.
    el.style.color = 'red';
    expect(el.style.color).toBe('red');
  });
});
