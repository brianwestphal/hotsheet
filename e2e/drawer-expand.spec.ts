/**
 * HS-6312: the bottom drawer has an expand/collapse button at the far right of
 * its tab bar. When expanded, the tickets area is hidden so the drawer fills
 * the full remaining viewport height. State persists per-project under
 * `drawer_expanded` alongside `drawer_open` / `drawer_active_tab`.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Drawer full-height expand', () => {
  test.beforeEach(async ({ request }) => {
    // The drawer state (open / expanded / active tab) persists per-project,
    // so tests here can bleed into each other. Reset to a known-clean
    // baseline before every test: drawer closed, not expanded, Commands Log
    // is the active tab.
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    const secret = projects[0]?.secret ?? '';
    await request.patch('/api/file-settings', {
      headers: { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret },
      data: {
        drawer_open: 'false',
        drawer_expanded: 'false',
        drawer_active_tab: 'commands-log',
      },
    });
  });

  test('expand button toggles full-height mode and hides the ticket area (HS-6312)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Open the drawer first (the expand button lives in the drawer's tab bar).
    await page.locator('#command-log-btn').click();
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 3000 });

    const app = page.locator('.app');
    const appBody = page.locator('.app-body');
    const expandBtn = page.locator('#drawer-expand-btn');

    // Baseline: ticket area visible, not yet expanded.
    await expect(expandBtn).toBeVisible();
    await expect(appBody).toBeVisible();
    await expect(app).not.toHaveClass(/drawer-expanded/);

    // Expand.
    await expandBtn.click();
    await expect(app).toHaveClass(/drawer-expanded/);
    await expect(appBody).toBeHidden();
    // Button now advertises the restore action and shows the down arrow.
    await expect(expandBtn).toHaveAttribute('title', /Restore tickets/);
    await expect(expandBtn.locator('.drawer-expand-icon-down')).toBeVisible();
    await expect(expandBtn.locator('.drawer-expand-icon-up')).toBeHidden();

    // Restore.
    await expandBtn.click();
    await expect(app).not.toHaveClass(/drawer-expanded/);
    await expect(appBody).toBeVisible();
    await expect(expandBtn).toHaveAttribute('title', /Expand drawer/);
    await expect(expandBtn.locator('.drawer-expand-icon-up')).toBeVisible();
    await expect(expandBtn.locator('.drawer-expand-icon-down')).toBeHidden();
  });

  test('closing the drawer clears the expanded state (HS-6312)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#command-log-btn').click();
    await page.locator('#drawer-expand-btn').click();
    await expect(page.locator('.app')).toHaveClass(/drawer-expanded/);

    // Closing the drawer must also collapse the expand flag — there is no
    // "expanded but closed" state.
    await page.locator('#command-log-btn').click();
    await expect(page.locator('#command-log-panel')).toBeHidden();
    await expect(page.locator('.app')).not.toHaveClass(/drawer-expanded/);
  });

  test('expanded state persists across reload (HS-6312)', async ({ page, request }) => {
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    const headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Open + expand the drawer, then wait for the debounced save to hit disk.
    await page.locator('#command-log-btn').click();
    await page.locator('#drawer-expand-btn').click();
    await expect(page.locator('.app')).toHaveClass(/drawer-expanded/);
    await page.waitForTimeout(300);

    // Confirm the setting was persisted.
    const fs = await (await request.get('/api/file-settings', { headers })).json() as { drawer_expanded?: string };
    expect(fs.drawer_expanded).toBe('true');

    // Reload — the drawer should come back open AND expanded. `.draft-input`
    // is inside the tickets area (.app-body) which the expand class hides,
    // so we wait on the drawer panel itself as the load signal.
    await page.reload();
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.app')).toHaveClass(/drawer-expanded/, { timeout: 5000 });
    await expect(page.locator('.app-body')).toBeHidden();
  });
});
