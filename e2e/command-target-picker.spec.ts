/**
 * HS-9083 (docs/103 §103.5) — E2E for the opt-in "Run on…" target picker on
 * Claude command buttons. The picker is a hover/focus-revealed chevron that opens
 * a menu: **Main** + the live workers + **All workers** (a "No workers running"
 * row when the pool is empty, as it is in e2e). Default single-click on the button
 * body stays Main (it does NOT open the picker) — the regression guard.
 *
 * Skip-guards mirror `command-long-press.spec.ts`: Claude command buttons only
 * render when the channel is enabled AND a compatible Claude CLI is present, so
 * the tests skip gracefully when the environment can't surface the button.
 */
import { expect, test } from './coverage-fixture.js';

type Page = import('@playwright/test').Page;

async function setCommandsAndReload(page: Page, items: unknown[]): Promise<void> {
  const origin = page.url().replace(/\/[^/]*$/, '');
  await page.request.patch('/api/settings', {
    data: { custom_commands: JSON.stringify(items) },
    headers: { Origin: origin },
  });
  await page.reload();
  await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
}

async function projectHeaders(page: Page): Promise<Record<string, string>> {
  const res = await page.request.get('/api/projects');
  const projects = await res.json() as { secret: string }[];
  return { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
}

/** Configure a single Claude command + return its button locator, or null when the
 *  environment doesn't surface Claude command buttons (no channel / no Claude CLI). */
async function claudeCommandButton(page: Page, name: string, prompt: string) {
  const headers = await projectHeaders(page);
  await page.request.post('/api/channel/enable', { headers });
  await setCommandsAndReload(page, [{ name, prompt, target: 'claude' }]);
  const container = page.locator('#channel-commands-container');
  if (await container.count() === 0) return null;
  const btn = container.locator('.channel-command-btn', { hasText: name });
  try {
    await expect(btn).toHaveCount(1, { timeout: 5000 });
  } catch {
    return null;
  }
  return btn;
}

test.describe('Command-button target picker (HS-9083)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test.afterEach(async ({ page }) => {
    try {
      const headers = await projectHeaders(page);
      await page.request.post('/api/channel/disable', { headers });
    } catch { /* ignore */ }
  });

  test('the chevron opens a Main + workers picker menu', async ({ page }) => {
    const btn = await claudeCommandButton(page, 'Picker Cmd', 'do a thing');
    if (btn === null) { test.skip(); return; }

    // Reveal the hover-gated chevron, then open the picker.
    await btn.hover();
    const chevron = btn.locator('.cmd-target-chevron');
    await expect(chevron).toHaveCount(1);
    await chevron.click();

    const menu = page.locator('.dropdown-menu');
    await expect(menu).toBeVisible({ timeout: 4000 });
    await expect(menu.locator('.dropdown-item', { hasText: 'Main' })).toBeVisible();
    // No workers registered in e2e ⇒ the informational row.
    await expect(menu.locator('.dropdown-item', { hasText: 'No workers running' })).toBeVisible();
  });

  test('single-clicking the button body does NOT open the picker (regression guard)', async ({ page }) => {
    const btn = await claudeCommandButton(page, 'Body Click', 'do a thing');
    if (btn === null) { test.skip(); return; }

    // A plain click on the button body routes to Main (the unchanged default) —
    // it must not open the target picker.
    await btn.click();
    await expect(page.locator('.dropdown-menu')).toHaveCount(0);
  });
});
