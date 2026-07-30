// HS-9497 (docs/132 §132.9.2) — the declaration/schema contract.
//
// Option A was chosen deliberately: `FileSettings` keeps STATIC zod fields rather than
// having plugins contribute them dynamically, because the server reads
// `fs.codex_interactive_permissions` and friends in typed positions all over, and a
// dynamic schema turns every one of those into an untyped index lookup. The cost is one
// residual duplicate line per setting — and this test is what makes that safe, by failing
// if a declared key is ever missing from the schema.
//
// So the pair can't drift silently: forget the zod field and this goes red, rather than
// the setting quietly failing to persist.

import { describe, expect, it } from 'vitest';

import { FileSettingsSchema } from '../file-settings.js';
import { listPlugins } from './registry.js';

const declared = listPlugins().flatMap(p => (p.preferences ?? []).map(pref => ({ tool: p.id, pref })));

describe('AI-tool preference declarations (HS-9497)', () => {
  it('declares at least the two migrated toggles, so this suite cannot pass vacuously', () => {
    const keys = declared.map(d => d.pref.key);
    expect(keys).toContain('antigravity_interactive_permissions');
    expect(keys).toContain('codex_interactive_permissions');
  });

  it('every declared key exists in the FileSettings zod schema', () => {
    const schemaKeys = new Set(Object.keys(FileSettingsSchema.shape));
    for (const { tool, pref } of declared) {
      expect(schemaKeys, `${tool} declares "${pref.key}" but FileSettings has no such field`).toContain(pref.key);
    }
  });

  it('keys are unique across every tool', () => {
    // They share one flat `FileSettings` namespace, so a collision would mean two tools
    // silently reading and writing each other's setting.
    const keys = declared.map(d => d.pref.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('carries an explicit default, and the two migrated toggles keep their ORIGINAL polarity', () => {
    for (const { pref } of declared) expect(typeof pref.default).toBe('boolean');

    // The regression this guards is silent and project-wide: antigravity's permissions
    // were `=== true` (absent ⇒ OFF) and codex's `!== false` (absent ⇒ ON, docs/121 O4).
    // Flipping either would change behavior for every existing project on upgrade.
    const byKey = new Map(declared.map(d => [d.pref.key, d.pref]));
    expect(byKey.get('antigravity_interactive_permissions')?.default).toBe(false);
    expect(byKey.get('codex_interactive_permissions')?.default).toBe(true);
  });

  it('every declaration is renderable — label present, boolean type', () => {
    for (const { tool, pref } of declared) {
      expect(pref.label, `${tool}:${pref.key} needs a label`).toBeTruthy();
      expect(pref.type).toBe('boolean');
    }
  });
});
