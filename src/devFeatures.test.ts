// HS-9411 (docs/124) — the In Development gate helpers. These are small, but the
// failure mode they guard is "a half-built surface is reachable by default", so
// the fail-closed behavior is pinned explicitly rather than assumed.
import { describe, expect, it } from 'vitest';

import {
  DEV_FEATURES,
  devFeatureForAiTool,
  type DevFeatureKey,
  isAiToolSelectable,
  isDevFeatureEnabled,
  isDevFeatureKey,
} from './devFeatures.js';
import { defaultScope } from './file-settings.js';

describe('DEV_FEATURES registry', () => {
  it('every key is dev_-prefixed, which is what routes it to the local layer', () => {
    for (const f of DEV_FEATURES) {
      expect(f.key.startsWith('dev_'), f.key).toBe(true);
      expect(defaultScope(f.key), f.key).toBe('local');
    }
  });

  it('keys are unique', () => {
    const keys = DEV_FEATURES.map(f => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every entry has a label and a hint', () => {
    for (const f of DEV_FEATURES) {
      expect(f.label.length, f.key).toBeGreaterThan(0);
      expect(f.hint.length, f.key).toBeGreaterThan(0);
    }
  });

  it('covers the five gated non-Claude drive tools and nothing else', () => {
    const tools = DEV_FEATURES.filter(f => f.aiTool !== undefined).map(f => f.aiTool);
    expect(new Set(tools)).toEqual(new Set(['codex', 'antigravity', 'opencode', 'gemini', 'goose']));
  });

  it('does NOT gate claude, auto, or the Tier-B editor tools', () => {
    for (const tool of ['auto', 'claude', 'cursor', 'copilot', 'windsurf']) {
      expect(devFeatureForAiTool(tool), tool).toBeNull();
    }
  });

  it('maps a gated tool to its feature, case-insensitively', () => {
    expect(devFeatureForAiTool('codex')?.key).toBe('dev_tool_codex');
    expect(devFeatureForAiTool('  CODEX ')?.key).toBe('dev_tool_codex');
  });

  it('recognizes its own keys and rejects others', () => {
    expect(isDevFeatureKey('dev_tool_codex')).toBe(true);
    expect(isDevFeatureKey('dev_not_a_real_gate')).toBe(false);
    expect(isDevFeatureKey('ai_tool')).toBe(false);
  });
});

describe('isDevFeatureEnabled — fails closed', () => {
  const KEY: DevFeatureKey = 'dev_tool_codex';

  it('is true only for an explicit boolean true', () => {
    expect(isDevFeatureEnabled({ [KEY]: true }, KEY)).toBe(true);
  });

  it('is false when absent', () => {
    expect(isDevFeatureEnabled({}, KEY)).toBe(false);
  });

  it.each([false, 'true', 1, null, undefined, {}])('is false for the non-boolean %p', (value) => {
    expect(isDevFeatureEnabled({ [KEY]: value }, KEY)).toBe(false);
  });
});

describe('isAiToolSelectable', () => {
  it('always offers an ungated tool regardless of gate state', () => {
    for (const tool of ['auto', 'claude', 'cursor']) {
      expect(isAiToolSelectable(tool, false, 'auto'), tool).toBe(true);
    }
  });

  it('offers a gated tool when its gate is on', () => {
    expect(isAiToolSelectable('codex', true, 'auto')).toBe(true);
  });

  it('hides a gated tool when its gate is off', () => {
    expect(isAiToolSelectable('codex', false, 'auto')).toBe(false);
  });

  // The maintainer-decided exception (HS-9411): hiding the option a project is
  // ALREADY set to would render the select blank and let the next change silently
  // rewrite a working project's tool.
  it('still offers a gated, gate-off tool when the project is already set to it', () => {
    expect(isAiToolSelectable('codex', false, 'codex')).toBe(true);
  });

  it('applies that exception case-insensitively', () => {
    expect(isAiToolSelectable('codex', false, 'CODEX')).toBe(true);
    expect(isAiToolSelectable('Codex', false, ' codex ')).toBe(true);
  });

  it('does not leak the exception to a DIFFERENT gated tool', () => {
    expect(isAiToolSelectable('opencode', false, 'codex')).toBe(false);
  });
});
