// @vitest-environment happy-dom
/**
 * HS-8830 — `activeElementUsesSpaceKey` guards the "Space = read latest note"
 * shortcut so it doesn't steal Space from a focused control that activates on it.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { activeElementUsesSpaceKey } from './shortcuts.js';

afterEach(() => { document.body.innerHTML = ''; });

function focus(html: string): void {
  document.body.innerHTML = html;
  document.querySelector<HTMLElement>('[data-focus]')?.focus();
}

describe('activeElementUsesSpaceKey (HS-8830)', () => {
  it('is true for a focused <button>', () => {
    focus('<button data-focus>Go</button>');
    expect(activeElementUsesSpaceKey()).toBe(true);
  });

  it('is true for a focused <a>', () => {
    focus('<a href="#" data-focus>link</a>');
    expect(activeElementUsesSpaceKey()).toBe(true);
  });

  it('is true for a role=button / role=checkbox element', () => {
    focus('<div tabindex="0" role="button" data-focus>x</div>');
    expect(activeElementUsesSpaceKey()).toBe(true);
    focus('<div tabindex="0" role="checkbox" data-focus>x</div>');
    expect(activeElementUsesSpaceKey()).toBe(true);
  });

  it('is false for a plain focused div / no focus', () => {
    focus('<div tabindex="0" data-focus>x</div>');
    expect(activeElementUsesSpaceKey()).toBe(false);
    document.body.innerHTML = '';
    expect(activeElementUsesSpaceKey()).toBe(false);
  });
});
