// HS-9517 — availability (is it shipped?) vs enablement (did the user opt in?).
//
// The failure modes here are quiet ones: a tool users were never meant to see appearing
// in a release, or a project silently switched off the tool it was already using. Both
// look fine in a screenshot.

import { describe, expect, it } from 'vitest';

import {
  aiToolEnabledKey,
  ALWAYS_ENABLED_TOOL,
  availableAiTools,
  isAiToolAvailable,
  isAiToolEnabled,
  isAiToolSelectable,
} from './enablement.js';
import { getPlugin, listPlugins } from './registry.js';

const plugin = (id: string) => {
  const p = getPlugin(id);
  if (p === null) throw new Error(`no plugin ${id}`);
  return p;
};

describe('maturity declarations (HS-9517)', () => {
  it('ships exactly Claude (stable) and Codex (beta) among the drives', () => {
    // The maintainer's requirement stated as an assertion: only these two reach users.
    expect(plugin('claude').maturity).toBe('stable');
    expect(plugin('codex').maturity).toBe('beta');
  });

  it('keeps every untested drive unreleased', () => {
    // Gemini has no drive at all and Goose is unimplemented — shipping either would put
    // a play button in front of users that cannot work.
    for (const id of ['antigravity', 'opencode', 'gemini', 'goose']) {
      expect(plugin(id).maturity, id).toBe('unreleased');
    }
  });

  it('every plugin declares a maturity', () => {
    for (const p of listPlugins()) {
      expect(['stable', 'beta', 'unreleased'], p.id).toContain(p.maturity);
    }
  });
});

describe('availability', () => {
  it('hides unreleased tools by default and reveals them behind the gate', () => {
    expect(isAiToolAvailable(plugin('gemini'), false)).toBe(false);
    expect(isAiToolAvailable(plugin('gemini'), true)).toBe(true);
  });

  it('always shows stable and beta', () => {
    for (const showUnreleased of [false, true]) {
      expect(isAiToolAvailable(plugin('claude'), showUnreleased)).toBe(true);
      expect(isAiToolAvailable(plugin('codex'), showUnreleased)).toBe(true);
    }
  });

  it('availableAiTools omits the four unreleased drives in a public build', () => {
    const ids = availableAiTools(false).map(p => p.id);
    expect(ids).toContain('claude');
    expect(ids).toContain('codex');
    for (const id of ['antigravity', 'opencode', 'gemini', 'goose']) expect(ids).not.toContain(id);
    // …and the gate brings back exactly those four, nothing more.
    expect(availableAiTools(true).length).toBe(ids.length + 4);
  });
});

describe('enablement', () => {
  it('defaults every tool OFF — bundled is not enabled', () => {
    expect(isAiToolEnabled('codex', {})).toBe(false);
  });

  it('CLAUDE is always enabled and cannot be turned off', () => {
    // It is the fallback transport, so a project with nothing enabled must still work —
    // this is what guarantees the picker can never be empty.
    expect(isAiToolEnabled('claude', {})).toBe(true);
    expect(isAiToolEnabled('claude', { 'ai_tool_enabled:claude': false })).toBe(true);
    expect(ALWAYS_ENABLED_TOOL).toBe('claude');
  });

  it('accepts the string "true" — the settings table stores strings', () => {
    expect(isAiToolEnabled('codex', { [aiToolEnabledKey('codex')]: 'true' })).toBe(true);
    expect(isAiToolEnabled('codex', { [aiToolEnabledKey('codex')]: true })).toBe(true);
  });

  it('treats the string "false" as OFF rather than truthy', () => {
    // A plain truthy check would enable the tool here, which is the bug this guards.
    expect(isAiToolEnabled('codex', { [aiToolEnabledKey('codex')]: 'false' })).toBe(false);
  });

  it('is case-insensitive on the tool id', () => {
    expect(isAiToolEnabled('CODEX', { [aiToolEnabledKey('codex')]: true })).toBe(true);
  });
});

describe('isAiToolSelectable', () => {
  const enabledCodex = { [aiToolEnabledKey('codex')]: true };

  it('always offers auto — a resolution mode, not a tool', () => {
    expect(isAiToolSelectable('auto', {}, 'claude', false)).toBe(true);
  });

  it('offers an enabled available tool, and withholds a disabled one', () => {
    expect(isAiToolSelectable('codex', enabledCodex, 'claude', false)).toBe(true);
    expect(isAiToolSelectable('codex', {}, 'claude', false)).toBe(false);
  });

  it('never offers an unreleased tool without the gate, even if enabled', () => {
    // Enablement must not be able to smuggle in something we did not ship — otherwise a
    // settings row copied between projects would resurrect it.
    const enabledGemini = { [aiToolEnabledKey('gemini')]: true };
    expect(isAiToolSelectable('gemini', enabledGemini, 'claude', false)).toBe(false);
    expect(isAiToolSelectable('gemini', enabledGemini, 'claude', true)).toBe(true);
  });

  it('ALWAYS offers the tool the project already uses (HS-9411 rule)', () => {
    // Hiding the selected value would silently switch a project that works today. This
    // holds even for a tool that is neither enabled nor shipped.
    expect(isAiToolSelectable('codex', {}, 'codex', false)).toBe(true);
    expect(isAiToolSelectable('gemini', {}, 'gemini', false)).toBe(true);
    expect(isAiToolSelectable('GEMINI', {}, 'gemini', false)).toBe(true); // case-insensitive
  });

  it('rejects an unknown id', () => {
    expect(isAiToolSelectable('not-a-tool', {}, 'claude', true)).toBe(false);
  });

  it('leaves Claude selectable with entirely empty settings', () => {
    // The floor: a brand-new project has no enablement rows at all and must still be
    // able to pick its default tool.
    expect(isAiToolSelectable('claude', {}, undefined, false)).toBe(true);
  });
});

describe('per-project isolation (docs/125 leak class)', () => {
  it('enabling in one project does not enable in another', () => {
    // The state is a plain per-project settings record, so this is structural rather
    // than defended — but the class of bug (state keyed globally, leaking across a
    // project switch) is common enough here to pin.
    const projectA = { [aiToolEnabledKey('codex')]: true };
    const projectB: Record<string, unknown> = {};
    expect(isAiToolEnabled('codex', projectA)).toBe(true);
    expect(isAiToolEnabled('codex', projectB)).toBe(false);
  });
});
