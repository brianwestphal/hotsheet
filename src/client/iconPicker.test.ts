// @vitest-environment happy-dom
/**
 * HS-9138 — the command icon/color picker popups (`iconPicker.tsx`, reached from
 * the custom-command editor). The `experimentalSettings` data + persistence is
 * mocked; the real `toElement` / `renderIconSvg` run so the DOM is exercised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { showColorDropdown, showIconPicker } from './iconPicker.js';

const cmd = vi.hoisted(() => ({ value: { icon: 'terminal', color: '#ff0000' } }));
const h = vi.hoisted(() => ({ updateCommand: vi.fn(), saveCommandItems: vi.fn() }));
vi.mock('./experimentalSettings.js', () => ({
  CMD_COLORS: [{ value: '#ff0000', label: 'Red' }, { value: '#00ff00', label: 'Green' }],
  CMD_ICONS: [
    { name: 'terminal', svg: '<path d="M1 1"/>' },
    { name: 'rocket', svg: '<path d="M2 2"/>' },
    { name: 'custom-thing', svg: '<path d="M3 3"/>' },
  ],
  resolveCommand: () => cmd.value,
  updateCommand: (ref: unknown, fn: (c: { icon: string; color: string }) => void) => { h.updateCommand(ref); fn(cmd.value); },
  saveCommandItems: () => { h.saveCommandItems(); return Promise.resolve(); },
}));

function anchor(): HTMLElement {
  const a = document.createElement('button');
  document.body.appendChild(a);
  return a;
}

beforeEach(() => { cmd.value = { icon: 'terminal', color: '#ff0000' }; h.updateCommand.mockReset(); h.saveCommandItems.mockReset(); });
afterEach(() => { document.body.innerHTML = ''; });

describe('showColorDropdown', () => {
  it('renders one item per color with the current color marked active', () => {
    showColorDropdown(anchor(), {} as never);
    const popup = document.querySelector('.color-dropdown-popup')!;
    const items = popup.querySelectorAll('.color-dropdown-item');
    expect(items).toHaveLength(2);
    expect(popup.querySelector('.color-dropdown-item.active')?.getAttribute('data-color')).toBe('#ff0000');
  });

  it('selecting a color updates the command, recolors the anchor, persists, and closes', () => {
    const a = anchor();
    showColorDropdown(a, {} as never);
    document.querySelector<HTMLElement>('.color-dropdown-item[data-color="#00ff00"]')!.click();
    expect(cmd.value.color).toBe('#00ff00');
    expect(a.style.background).toBe('#00ff00');
    expect(h.saveCommandItems).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.color-dropdown-popup')).toBeNull();
  });
});

describe('showIconPicker', () => {
  it('renders a search box + a grid with the featured separator and the active icon', () => {
    showIconPicker(anchor(), {} as never);
    const popup = document.querySelector('.icon-picker-popup')!;
    expect(popup.querySelector('.icon-picker-search')).not.toBeNull();
    expect(popup.querySelector('.icon-picker-separator')).not.toBeNull();
    expect(popup.querySelector('.icon-picker-item.active')?.getAttribute('title')).toBe('terminal');
  });

  it('selecting an icon updates the command, swaps the anchor glyph, persists, and closes', () => {
    const a = anchor();
    showIconPicker(a, {} as never);
    // The first matching 'rocket' button (featured list omits it, so it's in the rest).
    document.querySelector<HTMLElement>('.icon-picker-item[title="rocket"]')!.click();
    expect(cmd.value.icon).toBe('rocket');
    expect(a.querySelector('svg')).not.toBeNull();
    expect(h.saveCommandItems).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.icon-picker-popup')).toBeNull();
  });

  it('typing in the search filters the grid (no separator, only matches)', () => {
    showIconPicker(anchor(), {} as never);
    const search = document.querySelector<HTMLInputElement>('.icon-picker-search')!;
    search.value = 'custom';
    search.dispatchEvent(new Event('input'));
    const items = document.querySelectorAll('.icon-picker-item');
    expect(items).toHaveLength(1);
    expect(items[0].getAttribute('title')).toBe('custom-thing');
    expect(document.querySelector('.icon-picker-separator')).toBeNull();
  });
});
