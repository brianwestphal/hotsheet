/**
 * @vitest-environment happy-dom
 *
 * Unit tests for the HS-6307 appearance resolver + session-override map (see
 * docs/35-terminal-themes.md §35.4 + §35.8).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetSessionOverridesForTests,
  applyAppearanceToTerm,
  clearSessionOverride,
  FALLBACK_APPEARANCE,
  getSessionOverride,
  notifyDefaultAppearanceChanged,
  resolveAppearance,
  resolveAppearanceBackground,
  setSessionOverride,
  subscribeToDefaultAppearanceChanges,
  type XtermLikeForAppearance,
} from './terminalAppearance.js';
import { _resetFontCacheForTests } from './terminalFonts.js';
import { getThemeById, TERMINAL_THEMES } from './terminalThemes.js';

beforeEach(() => {
  _resetSessionOverridesForTests();
});

afterEach(() => {
  _resetFontCacheForTests();
});

describe('resolveAppearance', () => {
  it('returns the fallback when every layer is empty', () => {
    const out = resolveAppearance({});
    expect(out).toEqual(FALLBACK_APPEARANCE);
  });

  it('session override wins over config override wins over project default', () => {
    const out = resolveAppearance({
      projectDefault: { theme: 'dracula', fontFamily: 'fira-code', fontSize: 16 },
      configOverride: { theme: 'nord', fontFamily: 'jetbrains-mono' },
      sessionOverride: { theme: 'monokai' },
    });
    expect(out.theme).toBe('monokai');         // session
    expect(out.fontFamily).toBe('jetbrains-mono'); // config (no session override for font)
    expect(out.fontSize).toBe(16);             // project default
  });

  it('each field resolves independently', () => {
    const out = resolveAppearance({
      projectDefault: { theme: 'dracula' },
      configOverride: { fontSize: 18 },
      sessionOverride: { fontFamily: 'ubuntu-mono' },
    });
    expect(out.theme).toBe('dracula');
    expect(out.fontFamily).toBe('ubuntu-mono');
    expect(out.fontSize).toBe(18);
  });

  it('clamps an absurd fontSize to the shipped [8,32] range', () => {
    const low = resolveAppearance({ projectDefault: { fontSize: 2 } });
    const high = resolveAppearance({ projectDefault: { fontSize: 999 } });
    expect(low.fontSize).toBe(8);
    expect(high.fontSize).toBe(32);
  });

  it('falls back to default theme when the id is unknown', () => {
    const out = resolveAppearance({
      projectDefault: { theme: 'not-a-theme' },
    });
    expect(out.theme).toBe(FALLBACK_APPEARANCE.theme);
  });

  it('falls back to System font when the id is unknown', () => {
    const out = resolveAppearance({
      projectDefault: { fontFamily: 'not-a-font' },
    });
    expect(out.fontFamily).toBe(FALLBACK_APPEARANCE.fontFamily);
  });

  it('undefined fields are transparent (do not shadow a lower layer)', () => {
    const out = resolveAppearance({
      projectDefault: { theme: 'nord', fontFamily: 'fira-code', fontSize: 14 },
      configOverride: { theme: undefined, fontSize: undefined },
    });
    expect(out.theme).toBe('nord');
    expect(out.fontFamily).toBe('fira-code');
    expect(out.fontSize).toBe(14);
  });
});

describe('session override map', () => {
  it('starts empty and returns undefined for unknown terminal ids', () => {
    expect(getSessionOverride('term-1')).toBeUndefined();
  });

  it('setSessionOverride + getSessionOverride round-trips', () => {
    setSessionOverride('term-1', { theme: 'dracula' });
    expect(getSessionOverride('term-1')).toEqual({ theme: 'dracula' });
  });

  it('second setSessionOverride merges rather than replacing', () => {
    setSessionOverride('term-1', { theme: 'dracula' });
    setSessionOverride('term-1', { fontFamily: 'fira-code' });
    expect(getSessionOverride('term-1')).toEqual({ theme: 'dracula', fontFamily: 'fira-code' });
  });

  it('setSessionOverride with field: undefined deletes that field only', () => {
    setSessionOverride('term-1', { theme: 'dracula', fontFamily: 'fira-code' });
    setSessionOverride('term-1', { theme: undefined });
    expect(getSessionOverride('term-1')).toEqual({ fontFamily: 'fira-code' });
  });

  it('removing the last field deletes the entry entirely', () => {
    setSessionOverride('term-1', { theme: 'dracula' });
    setSessionOverride('term-1', { theme: undefined });
    expect(getSessionOverride('term-1')).toBeUndefined();
  });

  it('clearSessionOverride drops every field for that terminal', () => {
    setSessionOverride('term-1', { theme: 'dracula', fontFamily: 'fira-code', fontSize: 16 });
    clearSessionOverride('term-1');
    expect(getSessionOverride('term-1')).toBeUndefined();
  });

  it('overrides are per-terminal — setting one does not leak to another', () => {
    setSessionOverride('term-1', { theme: 'dracula' });
    setSessionOverride('term-2', { theme: 'nord' });
    expect(getSessionOverride('term-1')?.theme).toBe('dracula');
    expect(getSessionOverride('term-2')?.theme).toBe('nord');
  });
});

describe('applyAppearanceToTerm', () => {
  it('assigns theme / fontFamily / fontSize to the xterm instance', async () => {
    const term: XtermLikeForAppearance = { options: {} };
    await applyAppearanceToTerm(term, { theme: 'dracula', fontFamily: 'system', fontSize: 14 });
    expect(term.options.theme).toBeDefined();
    expect((term.options.theme as { background: string }).background).toBe('#282a36');
    expect(term.options.fontFamily).toContain('monospace');
    expect(term.options.fontSize).toBe(14);
  });

  it('clamps fontSize during apply too', async () => {
    const term: XtermLikeForAppearance = { options: {} };
    await applyAppearanceToTerm(term, { theme: 'default', fontFamily: 'system', fontSize: 99 });
    expect(term.options.fontSize).toBe(32);
  });

  it('unknown theme id falls back to default on apply', async () => {
    const term: XtermLikeForAppearance = { options: {} };
    await applyAppearanceToTerm(term, { theme: 'not-a-theme', fontFamily: 'system', fontSize: 13 });
    expect(term.options.theme).toBeDefined();
    // Default theme at the test baseline has the happy-dom fallback #ffffff bg
    expect((term.options.theme as { background: string }).background).toBeDefined();
  });

  it('unknown font id falls back to System on apply', async () => {
    const term: XtermLikeForAppearance = { options: {} };
    await applyAppearanceToTerm(term, { theme: 'default', fontFamily: 'not-a-font', fontSize: 13 });
    expect(term.options.fontFamily).toContain('ui-monospace');
  });
});

describe('project-default change pub/sub', () => {
  it('subscribe receives a notification on dispatch and unsubscribes cleanly', () => {
    let count = 0;
    const off = subscribeToDefaultAppearanceChanges(() => { count += 1; });
    notifyDefaultAppearanceChanged();
    notifyDefaultAppearanceChanged();
    expect(count).toBe(2);
    off();
    notifyDefaultAppearanceChanged();
    expect(count).toBe(2);
  });

  it('multiple subscribers all fire', () => {
    let a = 0;
    let b = 0;
    const offA = subscribeToDefaultAppearanceChanges(() => { a += 1; });
    const offB = subscribeToDefaultAppearanceChanges(() => { b += 1; });
    notifyDefaultAppearanceChanged();
    expect(a).toBe(1);
    expect(b).toBe(1);
    offA();
    offB();
  });
});

/**
 * HS-7960 — `resolveAppearanceBackground` returns the active theme's
 * background colour, used by the drawer + dashboard dedicated view to paint
 * the padded gutter around the xterm canvas in a colour that matches the
 * canvas itself (no app-coloured seam).
 */
describe('resolveAppearanceBackground (HS-7960)', () => {
  it('returns the configured theme bg for a known theme id', () => {
    const dracula = getThemeById('dracula');
    expect(dracula).not.toBeUndefined();
    const out = resolveAppearanceBackground({ theme: 'dracula', fontFamily: 'system', fontSize: 13 });
    expect(out).toBe(dracula!.background);
  });

  it('falls back to the default theme bg for an unknown theme id', () => {
    const def = getThemeById('default');
    expect(def).not.toBeUndefined();
    const out = resolveAppearanceBackground({ theme: 'no-such-theme', fontFamily: 'system', fontSize: 13 });
    expect(out).toBe(def!.background);
  });

  it('returns a non-empty colour string for every shipped theme', () => {
    for (const t of TERMINAL_THEMES) {
      const out = resolveAppearanceBackground({ theme: t.id, fontFamily: 'system', fontSize: 13 });
      expect(typeof out).toBe('string');
      expect(out.length).toBeGreaterThan(0);
      expect(out).toBe(t.background);
    }
  });
});
