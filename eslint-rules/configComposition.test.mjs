/**
 * HS-9518 — the `no-restricted-syntax` selector set must COMPOSE, not be replaced.
 *
 * ## The bug this exists to catch
 *
 * `eslint.config.mjs` carries this project's load-bearing AST backstops in ONE
 * rule: `no-restricted-syntax`. The sync-child-process guard (HS-9510/HS-9391),
 * the spread-argument-limit guard (HS-9451), `innerHTML` (§62), `JSON.parse(x)
 * as Y` (HS-8567) and the bind-disposer rule are all selectors inside it.
 *
 * Flat config REPLACES a rule's options rather than merging them. So a trailing
 * config object that says
 *
 *     { files: ["src/**"], rules: { "no-restricted-syntax": ["error", ONE_RULE] } }
 *
 * does not add `ONE_RULE` — it becomes the final word for every file it matches
 * and silently deletes every other selector. That shipped (HS-9495) and switched
 * off all five guards across the entire `src/` tree. Nothing failed: `npm run
 * lint` stayed green, because the rules were simply gone. It was found only while
 * investigating a server wedge, when an `execFileSync` with no `timeout` and no
 * `killSignal` turned out to be sitting on an HTTP handler, unflagged.
 *
 * A RuleTester cannot catch this — each rule was individually fine. The only
 * thing that catches it is resolving the REAL config for real files and asserting
 * the selector set that comes back, which is what this does.
 *
 * ## Adding an exemption
 *
 * Express it by SUBTRACTING from the shared array (`CORE_RULES.filter(...)`),
 * never by re-declaring a shorter list. If you add a file here that legitimately
 * drops a guard, add it to the matching case below with the reason.
 */
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/** Resolve the effective `no-restricted-syntax` options for one file. */
async function selectorsFor(filePath) {
  const eslint = new ESLint({ cwd: new URL('..', import.meta.url).pathname });
  const config = await eslint.calculateConfigForFile(filePath);
  const entry = config.rules['no-restricted-syntax'];
  // Shape is ["error", ...selectorObjects]; drop the severity.
  return entry.slice(1);
}

/** Does the resolved set contain a selector whose message cites this ticket? */
function cites(selectors, ticket) {
  return selectors.some((s) => typeof s === 'object' && s.message.includes(ticket));
}

describe('eslint.config.mjs — no-restricted-syntax composition', () => {
  // The guard whose loss caused the incident. It is the one rule that must hold
  // for EVERY file, production and test alike (HS-9511): a sync spawn wedges the
  // thread in native code, and a wedged test suite is harder to read than a
  // wedged server, not easier.
  it.each([
    ['src/routes/dashboard.ts', 'a plain server module'],
    ['src/client/backups.tsx', 'a client file on the §62 innerHTML allowlist'],
    ['src/client/settingsDialog.tsx', 'the file on the innerHTML AND tool-id lists'],
    ['src/devFeatures.ts', 'a file exempt from the tool-id rule'],
    ['src/aiTools/enablement.ts', 'the AI-tool plugin layer'],
    ['src/routes/dashboard.test.ts', 'a test file'],
  ])('keeps the sync-child-process guard for %s (%s)', async (file) => {
    const selectors = await selectorsFor(file);
    expect(cites(selectors, 'HS-9510')).toBe(true);
    // Both halves, not just one: HS-9391 was a call that already had `timeout`
    // and hung anyway, because `timeout` is enforced by sending `killSignal` and
    // that defaults to a signal the child can decline.
    const messages = selectors.filter((s) => typeof s === 'object').map((s) => s.message);
    expect(messages.some((m) => m.includes('no `timeout`'))).toBe(true);
    expect(messages.some((m) => m.includes('no `killSignal`'))).toBe(true);
  });

  // The spread-argument guard has the same everywhere-including-tests rationale
  // (HS-9455): a test is where you are most likely to build a huge fixture array.
  it.each([
    ['src/routes/dashboard.ts'],
    ['src/client/backups.tsx'],
    ['src/routes/dashboard.test.ts'],
  ])('keeps the spread-argument-limit guard for %s', async (file) => {
    expect(cites(await selectorsFor(file), 'HS-9451')).toBe(true);
  });

  it('keeps the innerHTML guard for a client file NOT on the allowlist', async () => {
    // `app.tsx` is deliberately not allowlisted, so it is the canary for net-new
    // client code — the case §62 Phase 3 was scoped around.
    expect(cites(await selectorsFor('src/client/app.tsx'), 'HS-8243')).toBe(true);
  });

  it('drops ONLY innerHTML for a file on the innerHTML allowlist', async () => {
    const selectors = await selectorsFor('src/client/backups.tsx');
    expect(cites(selectors, 'HS-8243')).toBe(false);
    // …and nothing else went with it. This is the assertion that would have
    // failed under the HS-9495 shape.
    expect(cites(selectors, 'HS-9510')).toBe(true);
    expect(cites(selectors, 'HS-9451')).toBe(true);
  });

  it('drops ONLY the tool-id rule for an exempt file', async () => {
    const selectors = await selectorsFor('src/devFeatures.ts');
    expect(cites(selectors, 'HS-9495')).toBe(false);
    expect(cites(selectors, 'HS-9510')).toBe(true);
    expect(cites(selectors, 'HS-8567')).toBe(true);
  });

  it('keeps the tool-id rule for generic server and client code', async () => {
    expect(cites(await selectorsFor('src/routes/dashboard.ts'), 'HS-9495')).toBe(true);
    expect(cites(await selectorsFor('src/client/app.tsx'), 'HS-9495')).toBe(true);
  });

  it('keeps test files exempt from the wire-boundary rules', async () => {
    // Tests legitimately build fixtures via `JSON.parse(x) as TestFixture`. The
    // exemption must come from the test block — an exemption block for some OTHER
    // rule must not accidentally hand a test file the full set. That regressed
    // once while fixing HS-9518 (12 hits across `src/acp`, `src/aiTools` and
    // `src/codex*.ts`, whose globs all match their own `.test.ts` files).
    const selectors = await selectorsFor('src/acp/acpDrive.test.ts');
    expect(cites(selectors, 'HS-8567')).toBe(false);
    expect(cites(selectors, 'HS-9510')).toBe(true);
  });
});
