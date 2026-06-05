/**
 * HS-8664 — the project tab strip is always shown (even for a single
 * project) and carries a trailing "+" add-project button.
 *
 * The e2e harness runs a single project, which pre-HS-8664 rendered a plain
 * `<h1>` title instead of a tab strip. This spec asserts the new always-
 * tabbed look: one `.project-tab`, no `h1`, and a `#add-project-btn` that
 * opens the in-app folder picker overlay (NOT a native `window`-level dialog
 * — Tauri's WKWebView silently no-ops those).
 */
import { expect, test } from './coverage-fixture.js';

test.describe('project tabs always-tabbed + add button (HS-8664)', () => {
  test('single project renders a tab strip with a trailing + button', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Always-tabbed: the strip exists with exactly one tab and no h1 title.
    await expect(page.locator('.project-tabs-inner')).toHaveCount(1);
    await expect(page.locator('.project-tab')).toHaveCount(1);
    await expect(page.locator('#app-title-area h1')).toHaveCount(0);

    // The add-project button is present and is the last child of the strip.
    const addBtn = page.locator('#add-project-btn.project-tab-add');
    await expect(addBtn).toBeVisible();
    const isLast = await page.evaluate(() => {
      const inner = document.querySelector('.project-tabs-inner');
      return inner?.lastElementChild?.id === 'add-project-btn';
    });
    expect(isLast).toBe(true);
  });

  test('clicking + opens the in-app folder picker overlay', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // The browser (non-Tauri) path shows the #open-folder-overlay. This is
    // the Tauri-safe affordance — no window.showDirectoryPicker / window
    // dialog that WKWebView would silently swallow.
    await expect(page.locator('#open-folder-overlay')).toBeHidden();
    await page.locator('#add-project-btn').click();
    await expect(page.locator('#open-folder-overlay')).toBeVisible({ timeout: 5000 });
  });
});
