// HS-9411 (docs/124) — the In Development gate helpers. These are small, but the
// failure mode they guard is "a half-built surface is reachable by default", so
// the fail-closed behavior is pinned explicitly rather than assumed.
import { describe, expect, it } from 'vitest';

import { DEV_FEATURES, type DevFeatureKey, isDevFeatureEnabled, isDevFeatureKey } from './devFeatures.js';
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

  it('recognizes its own keys and rejects others', () => {
    expect(isDevFeatureKey('dev_parallel_workers')).toBe(true);
    expect(isDevFeatureKey('dev_not_a_real_gate')).toBe(false);
    expect(isDevFeatureKey('ai_tool')).toBe(false);
  });
});

describe('isDevFeatureEnabled — fails closed', () => {
  const KEY: DevFeatureKey = 'dev_parallel_workers';

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

// HS-9515 — `isAiToolSelectable` / `devFeatureForAiTool` / the dropdown suffix are gone
// with the per-tool gates. No AI tool is gated any more, so there is no "offer this
// option only if the gate is on, or the project already uses it" rule left to test.
// What remains here gates FEATURES, which is what this mechanism is for.
describe('no AI tool is gated any more (HS-9515)', () => {
  it('the registry holds only feature gates, never a tool gate', () => {
    // Guards the regression directly: re-adding a `dev_tool_*` entry would resurrect
    // the asymmetry HS-9515 removed, where a project could show a tool selected while
    // its settings stayed hidden.
    for (const f of DEV_FEATURES) {
      expect(f.key.startsWith('dev_tool_'), `${f.key} is a per-tool gate`).toBe(false);
    }
  });
});
