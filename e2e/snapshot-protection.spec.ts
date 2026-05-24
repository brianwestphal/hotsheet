/**
 * HS-8594: Snapshot Protection settings toggle (docs/73-snapshot-protection.md §73.6).
 *
 * The Settings → Backups "Snapshot protection" checkbox is bound to the
 * `db_snapshot_protection` file-setting (default ON). This exercises the
 * real round-trip through the running app: open Settings, flip the toggle,
 * reload, and confirm the new state was persisted + rehydrated. Per the
 * project's web+Tauri rule we drive the in-app checkbox directly — no native
 * dialogs are involved.
 */
import type { Page } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

test.describe('Snapshot Protection toggle (HS-8594)', () => {
  let headers: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.afterAll(async ({ request }) => {
    // Restore the default (ON) so other tests / the user's project aren't
    // left with snapshot protection disabled.
    await request.patch('/api/file-settings', { headers, data: { db_snapshot_protection: true } });
  });

  async function openBackupsTab(page: Page) {
    // Opening Settings fires the panel's load fetches (GET /file-settings →
    // GET /api/db/snapshot-status). Wait for the (last) snapshot-status
    // response so BOTH have drained before any later toggle/reload — the
    // static "Checking…" placeholder would satisfy a not-empty text gate
    // before the real fetch lands, leaving a request to be aborted on reload.
    const loaded = page.waitForResponse((r) => r.url().includes('/api/db/snapshot-status'));
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
    await page.locator('.settings-tab[data-tab="backups"]').click();
    await expect(page.locator('.settings-tab-panel[data-panel="backups"]')).toHaveClass(/active/);
    await loaded;
    await expect(page.locator('#settings-snapshot-status')).not.toBeEmpty({ timeout: 5000 });
  }

  /** Flip the checkbox to `checked`, then wait for the PATCH to land + the
   *  follow-up status refresh to drain so a subsequent reload can't abort
   *  either. (`networkidle` is unusable here — the app polls continuously.)
   *  `/api/db/snapshot-status` is only fetched by the snapshot-protection
   *  refresh, so the response that follows the PATCH is the toggle's own. */
  async function setToggle(page: Page, checked: boolean) {
    const checkbox = page.locator('#settings-snapshot-protection');
    const patch = page.waitForResponse(
      (r) => r.url().includes('/api/file-settings') && r.request().method() === 'PATCH',
    );
    const refreshed = page.waitForResponse((r) => r.url().includes('/api/db/snapshot-status'));
    if (checked) await checkbox.check(); else await checkbox.uncheck();
    await patch;
    await refreshed;
  }

  test('checkbox defaults on, shows a status line, and persists toggling off then on', async ({ page, request }) => {
    // Start from a known default-ON state.
    await request.patch('/api/file-settings', { headers, data: { db_snapshot_protection: true } });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await openBackupsTab(page);
    // Default-on hydrates from file-settings.
    await expect(page.locator('#settings-snapshot-protection')).toBeChecked({ timeout: 5000 });

    // Turn it off — the change handler PATCHes file-settings.
    await setToggle(page, false);

    // Reload and confirm the off state was persisted + rehydrated.
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openBackupsTab(page);
    await expect(page.locator('#settings-snapshot-protection')).not.toBeChecked({ timeout: 5000 });

    // Turn it back on and confirm that persists too.
    await setToggle(page, true);
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openBackupsTab(page);
    await expect(page.locator('#settings-snapshot-protection')).toBeChecked({ timeout: 5000 });
  });
});
