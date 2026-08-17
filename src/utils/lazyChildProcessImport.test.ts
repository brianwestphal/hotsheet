/**
 * HS-9498 — the guard against the module-scope-`promisify` trap.
 *
 * Lives in its OWN file because `vi.mock` is file-scoped and hoisted: the partial
 * `child_process` mock below would also intercept the real-behavior tests in
 * `execAsync.test.ts`, where it silently made two `rejects.toThrow()` cases pass for
 * the wrong reason — they were catching the missing-export error, not the process
 * failure they claim to assert. A mock that makes a test pass by accident is worse
 * than no test, so the two concerns are separated.
 */
import { describe, expect, it, vi } from 'vitest';

/**
 * THE GUARD. `child_process` is mocked with only the exports `shell.test.ts` and
 * `dashboard.test.ts` actually name — deliberately WITHOUT `exec` or `execFile`,
 * which is the shape that broke them.
 *
 * Every module here shells out asynchronously. If any one goes back to
 * `promisify(execFile)` at module scope, its import below throws and this fails —
 * loudly, in a file whose name says why — instead of silently taking down an
 * unrelated route test months later.
 *
 * **Adding a module that shells out? Add it to this list** and import
 * `execAsync`/`execFileAsync` from `utils/execAsync.js` rather than promisifying at
 * module scope.
 */
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

const LAZY_EXEC_MODULES = [
  ['systemMemoryPressure (docs/131 — the one that broke dashboard + shell)', () => import('../db/systemMemoryPressure.js')],
  ['git/status (docs/75 — the HS-8723 precedent)', () => import('../git/status.js')],
  ['db/repair (docs/42)', () => import('../db/repair.js')],
  ['terminals/processInspect (docs/37)', () => import('../terminals/processInspect.js')],
] as const;

describe('modules that shell out import cleanly under a partial child_process mock (HS-9498)', () => {
  it.each(LAZY_EXEC_MODULES)('%s', async (_label, load) => {
    const mod = await load();
    expect(mod).toBeDefined();
  });
});
