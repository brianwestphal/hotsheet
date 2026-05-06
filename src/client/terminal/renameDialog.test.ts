/**
 * HS-8195 — Tests for the shared rename dialog extracted from
 * `terminal.tsx::promptRenameTerminal` + `terminalDashboard.tsx::openDashboardTileRename`.
 */
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openRenameDialog } from './renameDialog.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('openRenameDialog (HS-8195)', () => {
  it('mounts a single overlay with prefilled value + autofocus on the input', () => {
    openRenameDialog({ initialValue: 'my-tab', onApply: vi.fn() });
    const overlays = document.querySelectorAll('.terminal-rename-overlay');
    expect(overlays.length).toBe(1);
    const input = overlays[0].querySelector<HTMLInputElement>('.term-rename-input')!;
    expect(input.value).toBe('my-tab');
    expect(document.activeElement).toBe(input);
  });

  it('mounting again tears down the prior overlay first (idempotent)', () => {
    openRenameDialog({ initialValue: 'first', onApply: vi.fn() });
    openRenameDialog({ initialValue: 'second', onApply: vi.fn() });
    expect(document.querySelectorAll('.terminal-rename-overlay').length).toBe(1);
    const input = document.querySelector<HTMLInputElement>('.term-rename-input')!;
    expect(input.value).toBe('second');
  });

  it('Rename button calls onApply with the trimmed value and removes the overlay', () => {
    const onApply = vi.fn();
    openRenameDialog({ initialValue: '  current  ', onApply });
    const input = document.querySelector<HTMLInputElement>('.term-rename-input')!;
    input.value = '  new-name  ';
    document.querySelector<HTMLButtonElement>('.cmd-editor-done-btn')!.click();
    expect(onApply).toHaveBeenCalledWith('new-name');
    expect(document.querySelector('.terminal-rename-overlay')).toBeNull();
  });

  it('Enter key submits like the Rename button', () => {
    const onApply = vi.fn();
    openRenameDialog({ initialValue: 'old', onApply });
    const input = document.querySelector<HTMLInputElement>('.term-rename-input')!;
    input.value = 'fresh';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(onApply).toHaveBeenCalledWith('fresh');
    expect(document.querySelector('.terminal-rename-overlay')).toBeNull();
  });

  it('Cancel button closes the overlay without calling onApply', () => {
    const onApply = vi.fn();
    openRenameDialog({ initialValue: 'x', onApply });
    document.querySelector<HTMLButtonElement>('.cmd-editor-cancel-btn')!.click();
    expect(onApply).not.toHaveBeenCalled();
    expect(document.querySelector('.terminal-rename-overlay')).toBeNull();
  });

  it('X close button closes the overlay without calling onApply', () => {
    const onApply = vi.fn();
    openRenameDialog({ initialValue: 'x', onApply });
    document.querySelector<HTMLButtonElement>('.cmd-editor-close-btn')!.click();
    expect(onApply).not.toHaveBeenCalled();
    expect(document.querySelector('.terminal-rename-overlay')).toBeNull();
  });

  it('Escape key closes the overlay without calling onApply', () => {
    const onApply = vi.fn();
    openRenameDialog({ initialValue: 'x', onApply });
    const input = document.querySelector<HTMLInputElement>('.term-rename-input')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(onApply).not.toHaveBeenCalled();
    expect(document.querySelector('.terminal-rename-overlay')).toBeNull();
  });

  it('clicking the backdrop closes the overlay without calling onApply', () => {
    const onApply = vi.fn();
    const overlay = openRenameDialog({ initialValue: 'x', onApply });
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onApply).not.toHaveBeenCalled();
    expect(document.querySelector('.terminal-rename-overlay')).toBeNull();
  });

  it('clicking inside the dialog body does not close the overlay', () => {
    const onApply = vi.fn();
    openRenameDialog({ initialValue: 'x', onApply });
    const dialog = document.querySelector<HTMLElement>('.cmd-editor-dialog')!;
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.terminal-rename-overlay')).not.toBeNull();
  });

  it('submitting an empty value calls onApply with empty string (caller decides fallback)', () => {
    const onApply = vi.fn();
    openRenameDialog({ initialValue: 'old', onApply });
    const input = document.querySelector<HTMLInputElement>('.term-rename-input')!;
    input.value = '   ';
    document.querySelector<HTMLButtonElement>('.cmd-editor-done-btn')!.click();
    expect(onApply).toHaveBeenCalledWith('');
  });

  it('honours title / label / hint overrides', () => {
    openRenameDialog({
      initialValue: 'x',
      onApply: vi.fn(),
      title: 'Rename Tile',
      label: 'Tile name',
      hint: 'Custom hint text.',
    });
    const overlay = document.querySelector('.terminal-rename-overlay')!;
    expect(overlay.querySelector('.cmd-editor-dialog-header > span')!.textContent).toBe('Rename Tile');
    expect(overlay.querySelector('.settings-field > label')!.textContent).toBe('Tile name');
    expect(overlay.querySelector('.settings-hint')!.textContent).toBe('Custom hint text.');
  });
});
