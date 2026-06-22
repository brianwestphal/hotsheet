import { expect, test } from './coverage-fixture.js';

// HS-8922 — the TEST instance badge appears ONLY when Hot Sheet is launched with
// `--test`. The shared e2e server is a NORMAL launch (no `--test`), so the badge
// must be absent here — the real-browser half of the double coverage.
//
// The "present when --test" half is proven end-to-end by the server-spawn suite
// `src/cli.testMode.e2e.test.ts`, which boots a real `--test` instance and
// asserts the served page contains the badge markup + bound port (a separate
// browser launch on the fixed test port would risk colliding with a real test
// instance the developer is running).
test.describe('TEST instance badge (HS-8922)', () => {
  test('is absent on a normal (non --test) launch', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.test-instance-badge')).toHaveCount(0);
  });
});
