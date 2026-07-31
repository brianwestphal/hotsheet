import type { Page } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

/**
 * HS-9517 — AI tools are opt-in, like docs/18's bundled plugins: known and built in, but
 * not enabled until the user says so. Claude is always on (it is the fallback transport);
 * Codex ships as BETA but must be enabled; the untested integrations are not shipped at
 * all unless Settings → Experimental → "Unreleased AI tools" is on.
 */
test.describe('AI tool enablement (HS-9517)', () => {
  let headers: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    const projects = await (await request.get('/api/projects')).json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.afterAll(async ({ request }) => {
    await request.patch('/api/settings', { headers, data: { 'ai_tool_enabled:codex': 'false' } });
    await request.patch('/api/file-settings/layer', {
      headers, data: { layer: 'local', settings: { dev_unreleased_ai_tools: false } },
    });
  });

  const openAiTools = async (page: Page): Promise<void> => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible();
    await expect(page.locator('#ai-tools-list')).toBeVisible();
  };

  test('a fresh project offers only Claude; Codex is listed as BETA but off', async ({ page }) => {
    await openAiTools(page);

    // Claude is on and cannot be switched off — it is the fallback transport, so the
    // picker must never be able to end up empty.
    const claude = page.locator('#ai-tool-enabled-claude');
    await expect(claude).toBeChecked();
    await expect(claude).toBeDisabled();

    await expect(page.locator('#ai-tool-enabled-codex')).not.toBeChecked();
    await expect(page.locator('[data-ai-tool="codex"] .ai-tool-badge-beta')).toHaveText('BETA');

    // Untested integrations are not shipped: absent entirely, not merely unchecked.
    await expect(page.locator('[data-ai-tool="gemini"]')).toHaveCount(0);
    await expect(page.locator('[data-ai-tool="goose"]')).toHaveCount(0);

    // …and the picker offers only what is enabled.
    await expect(page.locator('#ai-tool-select option[value="claude"]')).not.toHaveAttribute('hidden', /.*/);
    await expect(page.locator('#ai-tool-select option[value="codex"]')).toHaveAttribute('hidden', /.*/);
  });

  test('enabling Codex makes it selectable immediately, without reopening Settings', async ({ page }) => {
    await openAiTools(page);
    await page.locator('#ai-tool-enabled-codex').check();

    // The picker refreshes off the same snapshot the checkbox just updated — a user who
    // ticks the box and finds the dropdown still refusing the tool would reasonably
    // conclude the checkbox does nothing.
    await expect(page.locator('#ai-tool-select option[value="codex"]')).not.toHaveAttribute('hidden', /.*/);
    await page.locator('#ai-tool-select').selectOption('codex');
    await expect(page.locator('#ai-tool-select')).toHaveValue('codex');
  });

  test('the Experimental gate reveals the unreleased integrations', async ({ page, request }) => {
    await request.patch('/api/file-settings/layer', {
      headers, data: { layer: 'local', settings: { dev_unreleased_ai_tools: true } },
    });
    await openAiTools(page);

    await expect(page.locator('[data-ai-tool="gemini"]')).toHaveCount(1);
    await expect(page.locator('[data-ai-tool="gemini"] .ai-tool-badge-unreleased')).toHaveText('UNRELEASED');
    // Revealed is not enabled — it still has to be opted into.
    await expect(page.locator('#ai-tool-enabled-gemini')).not.toBeChecked();
  });
});
