/**
 * @vitest-environment happy-dom
 *
 * HS-7896 regression coverage for the per-terminal appearance popover.
 *
 * Pre-fix the popover (a) ignored the configured override entirely when
 * computing its initial display state and (b) wrote new values to disk via
 * PATCH /file-settings without telling the caller, leaving `inst.config`
 * stale so `reapplyAppearance` re-applied the OLD theme to the live xterm.
 * Both bugs combined to make the gear button "do nothing" — the user reported
 * pattern in the ticket.
 *
 * These tests mount the popover into a happy-dom document, assert its
 * initial selected theme matches the configured override, fire a `change`
 * event on the theme `<select>`, and verify that `onConfigOverrideChange` is
 * called synchronously with the new value so the live xterm picks it up on
 * the next reapplyAppearance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetProjectDefaultForTests,
  _resetSessionOverridesForTests,
  setProjectDefault,
  type TerminalAppearance,
} from './terminalAppearance.js';
import { dismissAppearancePopover, mountAppearancePopover } from './terminalAppearancePopover.js';

beforeEach(() => {
  _resetSessionOverridesForTests();
  _resetProjectDefaultForTests();
  document.body.innerHTML = '';
});

afterEach(() => {
  dismissAppearancePopover();
});

function makeAnchor(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'terminal-appearance-btn';
  document.body.appendChild(btn);
  return btn;
}

describe('mountAppearancePopover (HS-7896)', () => {
  it('seeds the theme/font/size selects from the configured override the caller exposes', () => {
    setProjectDefault({ theme: 'default', fontFamily: 'system', fontSize: 14 });
    const anchor = makeAnchor();
    const onApply = vi.fn();
    const onConfigOverrideChange = vi.fn();

    mountAppearancePopover({
      anchor,
      terminalId: 'configured-1',
      isDynamic: false,
      onApply,
      getCurrentConfigOverride: () => ({ theme: 'dracula', fontFamily: 'fira-code', fontSize: 16 }),
      onConfigOverrideChange,
    });

    const themeSel = document.querySelector<HTMLSelectElement>('.terminal-appearance-theme')!;
    const fontSel = document.querySelector<HTMLSelectElement>('.terminal-appearance-font')!;
    const sizeInput = document.querySelector<HTMLInputElement>('.terminal-appearance-size')!;
    expect(themeSel.value).toBe('dracula');
    expect(fontSel.value).toBe('fira-code');
    expect(sizeInput.value).toBe('16');
  });

  it('falls back to project default when no configured override is exposed', () => {
    setProjectDefault({ theme: 'nord', fontFamily: 'jetbrains-mono', fontSize: 18 });
    const anchor = makeAnchor();

    mountAppearancePopover({
      anchor,
      terminalId: 'configured-2',
      isDynamic: false,
      onApply: () => undefined,
      getCurrentConfigOverride: () => ({}),
      onConfigOverrideChange: () => undefined,
    });

    const themeSel = document.querySelector<HTMLSelectElement>('.terminal-appearance-theme')!;
    const fontSel = document.querySelector<HTMLSelectElement>('.terminal-appearance-font')!;
    const sizeInput = document.querySelector<HTMLInputElement>('.terminal-appearance-size')!;
    expect(themeSel.value).toBe('nord');
    expect(fontSel.value).toBe('jetbrains-mono');
    expect(sizeInput.value).toBe('18');
  });

  it('calls onConfigOverrideChange synchronously when the theme select changes (configured terminal)', () => {
    setProjectDefault({});
    const anchor = makeAnchor();
    const onApply = vi.fn();
    const onConfigOverrideChange = vi.fn();

    mountAppearancePopover({
      anchor,
      terminalId: 'configured-3',
      isDynamic: false,
      onApply,
      getCurrentConfigOverride: () => ({ theme: 'default' }),
      onConfigOverrideChange,
    });

    const themeSel = document.querySelector<HTMLSelectElement>('.terminal-appearance-theme')!;
    themeSel.value = 'monokai';
    themeSel.dispatchEvent(new Event('change'));

    expect(onConfigOverrideChange).toHaveBeenCalledTimes(1);
    expect(onConfigOverrideChange).toHaveBeenCalledWith({ theme: 'monokai' });
    // onApply must fire AFTER onConfigOverrideChange so reapplyAppearance reads
    // the freshly-mutated inst.config.
    expect(onApply).toHaveBeenCalledTimes(1);
    const configCallOrder = onConfigOverrideChange.mock.invocationCallOrder[0]!;
    const applyCallOrder = onApply.mock.invocationCallOrder[0]!;
    expect(configCallOrder).toBeLessThan(applyCallOrder);
  });

  it('calls onConfigOverrideChange synchronously when the font select changes', () => {
    setProjectDefault({});
    const anchor = makeAnchor();
    const onConfigOverrideChange = vi.fn();

    mountAppearancePopover({
      anchor,
      terminalId: 'configured-4',
      isDynamic: false,
      onApply: () => undefined,
      getCurrentConfigOverride: () => ({}),
      onConfigOverrideChange,
    });

    const fontSel = document.querySelector<HTMLSelectElement>('.terminal-appearance-font')!;
    fontSel.value = 'jetbrains-mono';
    fontSel.dispatchEvent(new Event('change'));
    expect(onConfigOverrideChange).toHaveBeenCalledWith({ fontFamily: 'jetbrains-mono' });
  });

  it('calls onConfigOverrideChange when the +/- size buttons are clicked', () => {
    setProjectDefault({ fontSize: 14 });
    const anchor = makeAnchor();
    const onConfigOverrideChange = vi.fn();

    mountAppearancePopover({
      anchor,
      terminalId: 'configured-5',
      isDynamic: false,
      onApply: () => undefined,
      getCurrentConfigOverride: () => ({}),
      onConfigOverrideChange,
    });

    const inc = document.querySelector<HTMLButtonElement>('.terminal-appearance-size-inc')!;
    inc.click();
    expect(onConfigOverrideChange).toHaveBeenLastCalledWith({ fontSize: 15 });

    const dec = document.querySelector<HTMLButtonElement>('.terminal-appearance-size-dec')!;
    dec.click();
    expect(onConfigOverrideChange).toHaveBeenLastCalledWith({ fontSize: 14 });
  });

  it('reset-to-project-default fires onConfigOverrideChange with all-undefined values for configured terminals', () => {
    setProjectDefault({ theme: 'default' });
    const anchor = makeAnchor();
    const onConfigOverrideChange = vi.fn();

    mountAppearancePopover({
      anchor,
      terminalId: 'configured-6',
      isDynamic: false,
      onApply: () => undefined,
      getCurrentConfigOverride: () => ({ theme: 'monokai', fontSize: 22 }),
      onConfigOverrideChange,
    });

    const reset = document.querySelector<HTMLButtonElement>('.terminal-appearance-reset')!;
    reset.click();

    expect(onConfigOverrideChange).toHaveBeenCalledTimes(1);
    const arg = onConfigOverrideChange.mock.calls[0]?.[0] as Partial<TerminalAppearance> | undefined;
    expect(arg).toBeDefined();
    expect(arg?.theme).toBeUndefined();
    expect(arg?.fontFamily).toBeUndefined();
    expect(arg?.fontSize).toBeUndefined();
    expect(Object.keys(arg ?? {}).sort()).toEqual(['fontFamily', 'fontSize', 'theme']);
  });

  it('does NOT call onConfigOverrideChange for dynamic terminals — those flow through session overrides only', () => {
    setProjectDefault({});
    const anchor = makeAnchor();
    const onConfigOverrideChange = vi.fn();

    mountAppearancePopover({
      anchor,
      terminalId: 'dynamic-1',
      isDynamic: true,
      onApply: () => undefined,
      onConfigOverrideChange,
    });

    const themeSel = document.querySelector<HTMLSelectElement>('.terminal-appearance-theme')!;
    themeSel.value = 'dracula';
    themeSel.dispatchEvent(new Event('change'));

    expect(onConfigOverrideChange).not.toHaveBeenCalled();
  });
});
