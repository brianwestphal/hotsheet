/**
 * HS-9407 — per-project settings must not survive a project switch. `loadSettings()`
 * runs on every switch (`reloadAppState`), and its pre-fix `if (settings.X !== '')`
 * shape left the PREVIOUS project's value in state for any project that never
 * persisted its own (the HS-8451 / HS-9406 stale-carryover class).
 *
 * `settingsLoader.test.ts` pins the state transitions per field; this spec proves
 * the user-visible half against two genuinely-registered projects: open A, note its
 * header controls, visit a B that sets a different layout / sort / detail position,
 * come back to A, and require A to look exactly as it did before. Comparing A to
 * ITSELF (rather than to hard-coded defaults) keeps the spec honest whatever the
 * shared e2e server's project A happens to have persisted.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './coverage-fixture.js';

type Page = import('@playwright/test').Page;

/** The header controls `loadSettings` drives, as one comparable snapshot. */
async function readHeaderState(page: Page) {
  return await page.evaluate(() => ({
    sort: document.querySelector<HTMLSelectElement>('#sort-select')?.value ?? '',
    layout: document.querySelector<HTMLElement>('#layout-toggle .layout-btn.active')?.dataset.layout ?? '',
    detailPosition: document.querySelector<HTMLElement>('#detail-position-toggle .layout-btn.active')?.dataset.position ?? '',
  }));
}

/** Click a project tab and wait for the switch's settings reload to land. */
async function switchToProject(page: Page, secret: string): Promise<void> {
  const hydrated = page.waitForResponse(
    (r) => r.url().includes('/api/file-settings/layered') && r.url().includes(`project=${secret}`),
    { timeout: 10000 },
  );
  await page.locator(`.project-tab[data-secret="${secret}"]`).click();
  await expect(page.locator(`.project-tab.active[data-secret="${secret}"]`)).toBeVisible({ timeout: 5000 });
  await hydrated;
}

test.describe('Project switch resets per-project settings (HS-9407)', () => {
  test('a project that persisted no layout/sort/detail-position does not inherit the previous one', async ({ page, request }) => {
    // Register a real second project against a throwaway temp dir, with settings
    // deliberately different from the defaults. (Unregistered afterward like
    // e2e/cross-project-drag.spec.ts; the temp dir is left for the OS to reap —
    // the server still holds its PGLite handle.)
    const dataDir = join(mkdtempSync(join(tmpdir(), 'hs-9407-')), '.hotsheet');
    const res = await request.post('/api/projects/register', { data: { dataDir } });
    expect(res.ok(), 'second project should register').toBeTruthy();
    const projB = await res.json() as { secret: string };

    try {
      // (`sort_dir` stays `desc` — `#sort-select` only carries the six combos in
      // pages.tsx, and assigning an unrepresented one like `modified:asc` blanks
      // the select. `sort_by` alone is enough to prove the carryover.)
      await request.patch('/api/settings', {
        headers: { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projB.secret },
        data: { layout: 'list', sort_by: 'modified', sort_dir: 'desc', detail_position: 'bottom' },
      });

      await page.goto('/');
      await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
      await expect(page.locator(`.project-tab[data-secret="${projB.secret}"]`)).toBeVisible({ timeout: 5000 });
      const secretA = await page.evaluate(() => document.querySelector<HTMLElement>('.project-tab.active')?.dataset.secret ?? '');
      expect(secretA).not.toBe('');

      const beforeA = await readHeaderState(page);

      // Project B shows ITS settings…
      await switchToProject(page, projB.secret);
      const atB = await readHeaderState(page);
      expect(atB).toEqual({ sort: 'modified:desc', layout: 'list', detailPosition: 'bottom' });
      expect(atB, 'B must differ from A for this test to prove anything').not.toEqual(beforeA);

      // …and coming back to A restores A's, rather than leaving B's behind.
      await switchToProject(page, secretA);
      expect(await readHeaderState(page)).toEqual(beforeA);
    } finally {
      await request.delete(`/api/projects/${projB.secret}`).catch(() => undefined);
    }
  });
});
