/**
 * HS-8522 — end-to-end check that the typed API layer's runtime wiring works
 * in a real browser. The sidebar git chip was migrated from a raw
 * `api<GitStatusJson | null>('/git/status')` call to the typed
 * `apis.getGitStatus()` caller, which routes: caller → `apiCall` →
 * client-injected transport (`setApiTransport` in `app.tsx`) → `api()` →
 * fetch → zod-validate → render.
 *
 * Unit tests (`src/api/_runner.test.ts`, `src/api/git.test.ts`) cover the
 * caller/validation logic with a mocked transport; this spec is the only
 * thing that exercises the REAL `setApiTransport` boot wiring. The e2e
 * server's temp dataDir isn't a git repo (so `/git/status` would normally
 * return null and the chip would stay hidden), so we intercept the route and
 * return a fixture — proving the full typed path renders the chip.
 */
import { expect, test } from './coverage-fixture.js';

test('git chip renders via the typed API layer (HS-8522)', async ({ page }) => {
  // Intercept before navigation so it's in place when `initGitStatusChip`
  // fires its first fetch during boot. `api()` appends `?project=<secret>`,
  // so match the path prefix.
  await page.route('**/api/git/status**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        branch: 'feature/typed-api', detached: false, upstream: null,
        ahead: 0, behind: 0, staged: 2, unstaged: 1, untracked: 0,
        conflicted: 0, lastFetchedAt: null,
      }),
    });
  });

  await page.goto('/');
  await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

  // The chip starts `display:none` and is revealed + populated only when the
  // typed caller resolves a non-null, schema-valid status.
  const branch = page.locator('#sidebar-git-chip .sidebar-git-branch');
  await expect(branch).toHaveText('feature/typed-api', { timeout: 8000 });
  // Counts badge = staged + unstaged + untracked + conflicted = 3.
  await expect(page.locator('#sidebar-git-chip .sidebar-git-counts')).toHaveText('3');
});
