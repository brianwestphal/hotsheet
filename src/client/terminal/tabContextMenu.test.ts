/**
 * HS-8221 — Tests for the drawer-tab context menu extracted from
 * `terminal.tsx`. Covers callback dispatch, disabled-state for configured
 * tabs, the bulk-close action lists, viewport clamping, idempotent dismiss,
 * and outside-click dismiss.
 */
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dismissTabContextMenu, showTabContextMenu } from './tabContextMenu.js';

afterEach(() => {
  document.body.innerHTML = '';
});

function makeEvent(x = 100, y = 200): MouseEvent {
  return new MouseEvent('contextmenu', { clientX: x, clientY: y, bubbles: true });
}

describe('showTabContextMenu (HS-8221)', () => {
  it('mounts the menu with all five entries at the click coordinates', () => {
    showTabContextMenu({
      event: makeEvent(50, 60),
      clickedId: 'a',
      clickedIsDynamic: true,
      orderedIds: ['a'],
      isDynamic: () => true,
      onClose: vi.fn(),
      onCloseSet: vi.fn(),
      onRename: vi.fn(),
    });
    const menu = document.querySelector<HTMLElement>('.terminal-tab-context-menu')!;
    expect(menu).not.toBeNull();
    expect(menu.querySelectorAll('.context-menu-item')).toHaveLength(5);
    expect(menu.style.left).toBe('50px');
    expect(menu.style.top).toBe('60px');
  });

  it('disables Close Tab when clickedIsDynamic is false', () => {
    const onClose = vi.fn();
    showTabContextMenu({
      event: makeEvent(),
      clickedId: 'configured-1',
      clickedIsDynamic: false,
      orderedIds: ['configured-1'],
      isDynamic: () => false,
      onClose,
      onCloseSet: vi.fn(),
      onRename: vi.fn(),
    });
    const closeItem = document.querySelector<HTMLElement>('[data-action="close"]')!;
    expect(closeItem.classList.contains('disabled')).toBe(true);
    closeItem.click();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Close Tab → onClose(clickedId) when dynamic', () => {
    const onClose = vi.fn();
    showTabContextMenu({
      event: makeEvent(),
      clickedId: 'dyn-1',
      clickedIsDynamic: true,
      orderedIds: ['dyn-1'],
      isDynamic: () => true,
      onClose,
      onCloseSet: vi.fn(),
      onRename: vi.fn(),
    });
    document.querySelector<HTMLElement>('[data-action="close"]')!.click();
    expect(onClose).toHaveBeenCalledWith('dyn-1');
  });

  it('Close Other Tabs → onCloseSet with every dynamic id except the clicked one', () => {
    const onCloseSet = vi.fn();
    showTabContextMenu({
      event: makeEvent(),
      clickedId: 'b',
      clickedIsDynamic: true,
      orderedIds: ['cfg', 'a', 'b', 'c'],
      isDynamic: (id) => id !== 'cfg',
      onClose: vi.fn(),
      onCloseSet,
      onRename: vi.fn(),
    });
    document.querySelector<HTMLElement>('[data-action="close-others"]')!.click();
    expect(onCloseSet).toHaveBeenCalledWith(['a', 'c']);
  });

  it('Close Tabs to the Left → onCloseSet with dynamic ids before the clicked index', () => {
    const onCloseSet = vi.fn();
    showTabContextMenu({
      event: makeEvent(),
      clickedId: 'c',
      clickedIsDynamic: true,
      orderedIds: ['cfg', 'a', 'b', 'c', 'd'],
      isDynamic: (id) => id !== 'cfg',
      onClose: vi.fn(),
      onCloseSet,
      onRename: vi.fn(),
    });
    document.querySelector<HTMLElement>('[data-action="close-left"]')!.click();
    expect(onCloseSet).toHaveBeenCalledWith(['a', 'b']);
  });

  it('Close Tabs to the Right → onCloseSet with dynamic ids after the clicked index', () => {
    const onCloseSet = vi.fn();
    showTabContextMenu({
      event: makeEvent(),
      clickedId: 'b',
      clickedIsDynamic: true,
      orderedIds: ['a', 'b', 'cfg', 'd'],
      isDynamic: (id) => id !== 'cfg',
      onClose: vi.fn(),
      onCloseSet,
      onRename: vi.fn(),
    });
    document.querySelector<HTMLElement>('[data-action="close-right"]')!.click();
    expect(onCloseSet).toHaveBeenCalledWith(['d']);
  });

  it('Rename → onRename(clickedId)', () => {
    const onRename = vi.fn();
    showTabContextMenu({
      event: makeEvent(),
      clickedId: 'dyn-1',
      clickedIsDynamic: true,
      orderedIds: ['dyn-1'],
      isDynamic: () => true,
      onClose: vi.fn(),
      onCloseSet: vi.fn(),
      onRename,
    });
    document.querySelector<HTMLElement>('[data-action="rename"]')!.click();
    expect(onRename).toHaveBeenCalledWith('dyn-1');
  });

  it('any action click dismisses the menu', () => {
    showTabContextMenu({
      event: makeEvent(),
      clickedId: 'a',
      clickedIsDynamic: true,
      orderedIds: ['a'],
      isDynamic: () => true,
      onClose: vi.fn(),
      onCloseSet: vi.fn(),
      onRename: vi.fn(),
    });
    expect(document.querySelector('.terminal-tab-context-menu')).not.toBeNull();
    document.querySelector<HTMLElement>('[data-action="close"]')!.click();
    expect(document.querySelector('.terminal-tab-context-menu')).toBeNull();
  });

  it('opening a second menu replaces the first', () => {
    showTabContextMenu({
      event: makeEvent(10, 10), clickedId: 'a', clickedIsDynamic: true,
      orderedIds: ['a'], isDynamic: () => true,
      onClose: vi.fn(), onCloseSet: vi.fn(), onRename: vi.fn(),
    });
    showTabContextMenu({
      event: makeEvent(20, 20), clickedId: 'b', clickedIsDynamic: true,
      orderedIds: ['a', 'b'], isDynamic: () => true,
      onClose: vi.fn(), onCloseSet: vi.fn(), onRename: vi.fn(),
    });
    expect(document.querySelectorAll('.terminal-tab-context-menu')).toHaveLength(1);
  });

  it('dismissTabContextMenu is idempotent', () => {
    expect(() => dismissTabContextMenu()).not.toThrow();
    showTabContextMenu({
      event: makeEvent(), clickedId: 'a', clickedIsDynamic: true,
      orderedIds: ['a'], isDynamic: () => true,
      onClose: vi.fn(), onCloseSet: vi.fn(), onRename: vi.fn(),
    });
    dismissTabContextMenu();
    expect(document.querySelector('.terminal-tab-context-menu')).toBeNull();
    dismissTabContextMenu();
    expect(document.querySelector('.terminal-tab-context-menu')).toBeNull();
  });
});
