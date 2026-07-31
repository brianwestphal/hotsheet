// @vitest-environment happy-dom
// HS-9517 — the opt-in list and the picker filter it feeds.
//
// The two failures worth guarding are both silent: a tool we never shipped becoming
// pickable, and a project losing access to the tool it is already using.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ updateSettings: vi.fn(() => Promise.resolve({})) }));
vi.mock('../api/index.js', () => ({ updateSettings: h.updateSettings }));

const { applyAiToolAvailability, renderAiToolsSection } = await import('./aiToolsSection.js');
const { aiToolEnabledKey } = await import('../aiTools/enablement.js');

const noop = (): void => { /* not asserted here */ };

function picker(): HTMLSelectElement {
  document.body.innerHTML = `
    <select id="s">
      <option value="auto">Auto-detect (default)</option>
      <option value="claude">Claude Code</option>
      <option value="codex">Codex</option>
      <option value="gemini">Gemini CLI</option>
    </select>`;
  return document.getElementById('s') as HTMLSelectElement;
}
const shown = (s: HTMLSelectElement): string[] =>
  Array.from(s.options).filter(o => o.hidden !== true).map(o => o.value);

beforeEach(() => { vi.clearAllMocks(); document.body.innerHTML = ''; });

describe('renderAiToolsSection', () => {
  it('lists shipped tools only, with Claude locked on', () => {
    const el = document.createElement('div');
    renderAiToolsSection(el, {}, false, noop);

    const ids = Array.from(el.querySelectorAll('[data-ai-tool]')).map(r => r.getAttribute('data-ai-tool'));
    expect(ids).toContain('claude');
    expect(ids).toContain('codex');
    expect(ids).not.toContain('gemini'); // unreleased — not shipped

    const claude = el.querySelector<HTMLInputElement>('#ai-tool-enabled-claude');
    expect(claude?.checked).toBe(true);
    expect(claude?.disabled).toBe(true); // the fallback transport can't be switched off
    expect(el.querySelector<HTMLInputElement>('#ai-tool-enabled-codex')?.checked).toBe(false);
  });

  it('badges Codex as BETA', () => {
    const el = document.createElement('div');
    renderAiToolsSection(el, {}, false, noop);
    const row = el.querySelector('[data-ai-tool="codex"]');
    expect(row?.querySelector('.ai-tool-badge-beta')?.textContent).toBe('BETA');
  });

  it('adds the unreleased tools behind the gate, badged', () => {
    const el = document.createElement('div');
    renderAiToolsSection(el, {}, true, noop);
    const gemini = el.querySelector('[data-ai-tool="gemini"]');
    expect(gemini).not.toBeNull();
    expect(gemini?.querySelector('.ai-tool-badge-unreleased')?.textContent).toBe('UNRELEASED');
  });

  it('persists an enable as a STRING and reports it', () => {
    const el = document.createElement('div');
    const changes: [string, boolean][] = [];
    renderAiToolsSection(el, {}, false, (id, on) => changes.push([id, on]));

    const codex = el.querySelector<HTMLInputElement>('#ai-tool-enabled-codex');
    if (codex === null) throw new Error('no codex row');
    codex.checked = true;
    codex.dispatchEvent(new Event('change'));

    // String, not boolean: the settings table stores strings.
    expect(h.updateSettings).toHaveBeenCalledWith({ [aiToolEnabledKey('codex')]: 'true' });
    expect(changes).toEqual([['codex', true]]);
  });

  it('reflects an already-enabled tool as checked', () => {
    const el = document.createElement('div');
    renderAiToolsSection(el, { [aiToolEnabledKey('codex')]: 'true' }, false, noop);
    expect(el.querySelector<HTMLInputElement>('#ai-tool-enabled-codex')?.checked).toBe(true);
  });
});

describe('applyAiToolAvailability', () => {
  it('offers only auto + Claude for a fresh project', () => {
    const s = picker();
    applyAiToolAvailability(s, {}, 'auto', false);
    expect(shown(s)).toEqual(['auto', 'claude']);
  });

  it('adds Codex once enabled, labeled beta', () => {
    const s = picker();
    applyAiToolAvailability(s, { [aiToolEnabledKey('codex')]: 'true' }, 'auto', false);
    expect(shown(s)).toEqual(['auto', 'claude', 'codex']);
    expect(s.querySelector<HTMLOptionElement>('option[value="codex"]')?.textContent).toBe('Codex — beta');
  });

  it('DISABLES hidden options, not just hides them', () => {
    // A hidden option is still assignable by value, so a stale saved setting could
    // otherwise re-select a tool the user cannot see or turn off.
    const s = picker();
    applyAiToolAvailability(s, {}, 'auto', false);
    expect(s.querySelector<HTMLOptionElement>('option[value="codex"]')?.disabled).toBe(true);
  });

  it('never hides the tool the project already uses, even unshipped and unenabled', () => {
    // Losing the selected value would silently switch a project that works today.
    const s = picker();
    applyAiToolAvailability(s, {}, 'gemini', false);
    expect(shown(s)).toContain('gemini');
  });

  it('does not let enablement smuggle in an unreleased tool', () => {
    const s = picker();
    applyAiToolAvailability(s, { [aiToolEnabledKey('gemini')]: 'true' }, 'auto', false);
    expect(shown(s)).not.toContain('gemini');
  });

  it('keeps labels stable across repeated applies', () => {
    // The suffix is appended, not stored — re-running must not yield "Codex — beta — beta".
    const s = picker();
    const settings = { [aiToolEnabledKey('codex')]: 'true' };
    applyAiToolAvailability(s, settings, 'auto', false);
    applyAiToolAvailability(s, settings, 'auto', false);
    expect(s.querySelector<HTMLOptionElement>('option[value="codex"]')?.textContent).toBe('Codex — beta');
  });
});
