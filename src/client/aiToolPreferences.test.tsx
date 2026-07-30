// @vitest-environment happy-dom
// HS-9497 (docs/132 §132.9.2), step 2 — rendering a tool's declared settings.
//
// The regression these guard is quiet rather than loud: a wrong default flips a toggle
// for every existing project on upgrade, and a mis-rendered hint just looks slightly
// worse forever. Both are the kind of thing a green build hides.

import { describe, expect, it } from 'vitest';

import type { AiToolPreference } from '../aiTools/types.js';
import { buildAiToolPreferenceRows, preferenceValue } from './aiToolPreferences.js';
import { formatPrefDescription } from './prefDescription.js';

const offByDefault: AiToolPreference = {
  key: 'antigravity_interactive_permissions', label: 'Interactive permission prompts (Antigravity)',
  type: 'boolean', default: false, description: 'Runs `agy` **without** the bypass.',
};
const onByDefault: AiToolPreference = {
  key: 'codex_interactive_permissions', label: 'Interactive permission prompts (Codex)',
  type: 'boolean', default: true,
};

describe('preferenceValue — the default is per-tool, not a constant', () => {
  it('uses the declared default when the key is absent', () => {
    expect(preferenceValue(offByDefault, {})).toBe(false);
    expect(preferenceValue(onByDefault, {})).toBe(true); // docs/121 O4 — absent means ON
  });

  it('an explicit stored value wins over the default, in both directions', () => {
    expect(preferenceValue(offByDefault, { antigravity_interactive_permissions: true })).toBe(true);
    // The one that actually broke people if mishandled: explicit false must beat a
    // default of true, which is exactly what the old `!== false` check encoded.
    expect(preferenceValue(onByDefault, { codex_interactive_permissions: false })).toBe(false);
  });

  it('ignores a non-boolean stored value rather than coercing it', () => {
    expect(preferenceValue(onByDefault, { codex_interactive_permissions: 'false' })).toBe(true);
  });
});

describe('buildAiToolPreferenceRows', () => {
  const noop = (): void => { /* not asserted here */ };

  it('renders nothing for a tool with no declared preferences', () => {
    // This is what replaces the reveal branch: no hidden field, simply no rows.
    expect(buildAiToolPreferenceRows([], {}, noop)).toEqual([]);
  });

  it('renders a settings-field row matching the surrounding dialog, not a plugin row', () => {
    const [row] = buildAiToolPreferenceRows([offByDefault], {}, noop);
    expect(row.className).toBe('settings-field');
    expect(row.querySelector('.plugin-pref-row')).toBeNull();
    expect(row.textContent).toContain('Interactive permission prompts (Antigravity)');
  });

  it('reflects the current value, defaulting per declaration', () => {
    const [agy] = buildAiToolPreferenceRows([offByDefault], {}, noop);
    expect(agy.querySelector<HTMLInputElement>('input')?.checked).toBe(false);
    const [codex] = buildAiToolPreferenceRows([onByDefault], {}, noop);
    expect(codex.querySelector<HTMLInputElement>('input')?.checked).toBe(true);
  });

  it('reports a toggle with the preference it belongs to', () => {
    const seen: [string, boolean][] = [];
    const [row] = buildAiToolPreferenceRows([offByDefault], {}, (pref, value) => { seen.push([pref.key, value]); });
    const input = row.querySelector('input');
    if (!(input instanceof HTMLInputElement)) throw new Error('no checkbox rendered');
    input.checked = true;
    input.dispatchEvent(new Event('change'));
    expect(seen).toEqual([['antigravity_interactive_permissions', true]]);
  });

  it('keeps the inline formatting the hand-written hint had', () => {
    const [row] = buildAiToolPreferenceRows([offByDefault], {}, noop);
    const hint = row.querySelector('.settings-hint');
    expect(hint?.querySelector('code')?.textContent).toBe('agy');
    expect(hint?.querySelector('strong')?.textContent).toBe('without');
  });

  it('gives each row a stable key hook and input id for tests and E2E', () => {
    const [row] = buildAiToolPreferenceRows([offByDefault], {}, noop);
    expect(row.getAttribute('data-pref-key')).toBe('antigravity_interactive_permissions');
    expect(row.querySelector('#settings-pref-antigravity_interactive_permissions')).not.toBeNull();
  });
});

describe('formatPrefDescription — escape FIRST, then our own tags', () => {
  it('renders the two supported constructs', () => {
    expect(formatPrefDescription('use `x` and **y**')).toBe('use <code>x</code> and <strong>y</strong>');
  });

  it('escapes HTML, so a description can never contribute a tag', () => {
    // The safety argument for `raw()`ing the result: by the time any markup exists in
    // the string, it is markup we wrote.
    expect(formatPrefDescription('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(formatPrefDescription('a & b')).toBe('a &amp; b');
    expect(formatPrefDescription(`he said "hi" it's fine`)).toBe('he said &quot;hi&quot; it&#39;s fine');
  });

  it('escapes inside a code span too', () => {
    expect(formatPrefDescription('`<script>`')).toBe('<code>&lt;script&gt;</code>');
  });

  it('leaves unmatched markers alone rather than guessing', () => {
    expect(formatPrefDescription('a * b ** c ` d')).toBe('a * b ** c ` d');
  });
});

// HS-9497 — a transition test, not a single-operation one. Rows used to persist across
// tool switches (they were merely hidden); now they are rebuilt from the settings the
// dialog is holding. So a toggle made in this dialog session has to survive switching
// away and back, which only works if the caller folds the new value into that snapshot.
// Every individual operation here passes in isolation; the bug would live in the SEQUENCE.
describe('toggle → switch away → switch back (HS-9497)', () => {
  it('re-renders the toggled value, not the value the dialog opened with', () => {
    const pref: AiToolPreference = {
      key: 'antigravity_interactive_permissions', label: 'Prompts', type: 'boolean', default: false,
    };
    // The settings snapshot the dialog holds, updated the way settingsDialog does it.
    let snapshot: Record<string, unknown> = {};
    const onChange = (p: AiToolPreference, value: boolean): void => {
      snapshot = { ...snapshot, [p.key]: value };
    };

    const [first] = buildAiToolPreferenceRows([pref], snapshot, onChange);
    const input = first.querySelector('input');
    if (!(input instanceof HTMLInputElement)) throw new Error('no checkbox');
    expect(input.checked).toBe(false);

    input.checked = true;
    input.dispatchEvent(new Event('change'));

    // Switch away (no rows), then back — rebuilt from the updated snapshot.
    expect(buildAiToolPreferenceRows([], snapshot, onChange)).toEqual([]);
    const [rebuilt] = buildAiToolPreferenceRows([pref], snapshot, onChange);
    expect(rebuilt.querySelector<HTMLInputElement>('input')?.checked).toBe(true);
  });
});
