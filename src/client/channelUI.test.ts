// @vitest-environment happy-dom
/**
 * §61 / HS-8238 — coverage for the trial migration of attention-dot
 * state to a kerf `defineStore`. The store-level wiring is exercised
 * via the public mark / clear helpers exported from `channelUI.tsx`,
 * so the test pins the production contract not the internal store
 * shape.
 *
 * `_projectAttentionStoreForTesting.reset()` is called in `beforeEach`
 * to isolate cases — the in-module `Set`-backed store would otherwise
 * leak state across tests since `defineStore` registers globally.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _projectAttentionStoreForTesting,
  clearProjectAttention,
  getProjectAttentionSecrets,
  markProjectAttention,
} from './channelUI.js';
import { resetAllStores } from './reactive.js';

beforeEach(() => {
  // Mount a no-op `.project-tab-dot` so the lazy-imported `syncDots`
  // path inside mark/clearAttention finds a target to write to (even
  // though we don't assert dot styling here — that's projectTabs.tsx
  // territory). Without it, syncDots short-circuits cleanly anyway.
  document.body.innerHTML = '';
  _projectAttentionStoreForTesting.reset();
});

afterEach(() => {
  _projectAttentionStoreForTesting.reset();
  document.body.innerHTML = '';
});

describe('channelUI attention store (HS-8238 / §61 Phase 1 trial)', () => {
  it('initial state — no projects flagged', () => {
    expect(getProjectAttentionSecrets().size).toBe(0);
  });

  it('markProjectAttention adds the secret + clearProjectAttention removes it', () => {
    markProjectAttention('sec-a');
    expect(getProjectAttentionSecrets().has('sec-a')).toBe(true);

    markProjectAttention('sec-b');
    expect(getProjectAttentionSecrets().size).toBe(2);

    clearProjectAttention('sec-a');
    expect(getProjectAttentionSecrets().has('sec-a')).toBe(false);
    expect(getProjectAttentionSecrets().has('sec-b')).toBe(true);
  });

  it('marking an already-flagged project is a no-op (no duplicate, no throw)', () => {
    markProjectAttention('sec-a');
    markProjectAttention('sec-a');
    markProjectAttention('sec-a');
    expect(getProjectAttentionSecrets().size).toBe(1);
  });

  it('clearing an unflagged project is a no-op (no throw)', () => {
    expect(() => clearProjectAttention('never-flagged')).not.toThrow();
    expect(getProjectAttentionSecrets().size).toBe(0);
  });

  it('store reset() returns to the initial empty Set', () => {
    markProjectAttention('sec-a');
    markProjectAttention('sec-b');
    expect(getProjectAttentionSecrets().size).toBe(2);
    _projectAttentionStoreForTesting.reset();
    expect(getProjectAttentionSecrets().size).toBe(0);
  });

  it('global resetAllStores() also resets the attention store (registry membership)', () => {
    markProjectAttention('sec-a');
    expect(getProjectAttentionSecrets().size).toBe(1);
    resetAllStores();
    expect(getProjectAttentionSecrets().size).toBe(0);
  });

  it('store mutations produce a new Set reference each time (immutable update — required for downstream signal-driven consumers)', () => {
    const before = getProjectAttentionSecrets();
    markProjectAttention('sec-a');
    const after = getProjectAttentionSecrets();
    expect(after).not.toBe(before);
    expect(before.size).toBe(0);
    expect(after.size).toBe(1);
  });
});
