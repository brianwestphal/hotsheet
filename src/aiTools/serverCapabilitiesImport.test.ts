/**
 * HS-9503 — `serverCapabilities.ts` must import cleanly when `skills.js` is PARTIALLY
 * mocked.
 *
 * The capability table maps plugin id → generator, and the obvious spelling
 * (`ensure: ensureClaudeSkills`) reads the imported binding while the object literal is
 * being evaluated — at module scope. Any test that partially mocks `skills.js` for its
 * own reasons then dies at import the moment this module joins its dependency graph,
 * with an error naming a file it has never heard of.
 *
 * That is the HS-9498 trap exactly, one level up, and it happened: writing the table
 * with bare references took down `routes/api.test.ts` and
 * `routes/attachmentCopyCrossProject.test.ts` in full. Those suites caught it, but by
 * accident — they mock `skills.js` for unrelated reasons. This makes the property
 * explicit, so the next occurrence fails in a file whose name says what broke.
 *
 * The fix in both cases is the same: resolve late. Wrap the generator instead of
 * referencing it, and the lookup happens at call time.
 */
import { describe, expect, it, vi } from 'vitest';

// Deliberately partial — names nothing the capability table uses, mirroring how a real
// test mocks only the exports it cares about.
vi.mock('../skills.js', () => ({
  ensureSkills: vi.fn(() => []),
}));

describe('serverCapabilities imports under a partial skills mock (HS-9503)', () => {
  it('loads, and its lookups work', async () => {
    const mod = await import('./serverCapabilities.js');
    expect(mod.skillsCapabilityIds().length).toBeGreaterThan(0);
    expect(mod.skillsCapabilityFor('claude')).not.toBeNull();
    expect(mod.skillsCapabilityFor('goose')).toBeNull();
  });

  it('defers the generator lookup to call time, not module evaluation', async () => {
    const { skillsCapabilityFor } = await import('./serverCapabilities.js');
    const capability = skillsCapabilityFor('claude')!;
    // Reaching the table at all is the assertion; CALLING through it must fail against
    // this mock (the export is absent), which is the point — the failure belongs at the
    // call, inside whatever error handling the caller has, not at import.
    expect(() => capability.ensure('/tmp/nope', '/tmp/nope/.hotsheet')).toThrow();
  });
});
