/**
 * HS-5062: plugin config dialog field validation feedback in the UI.
 *
 * User expectation: "as I type into a plugin config field, I see immediate
 * inline feedback if my value is wrong." The existing test suite only checks
 * the validate endpoint returns the right JSON shape — it never drives a real
 * input in the open config dialog. These tests open the dialog, type, and
 * assert the feedback element renders with the right class and text.
 */
import type { Page, APIRequestContext } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

const PLUGINS_ENABLED = process.env.PLUGINS_ENABLED === 'true';

test.describe('Plugin config dialog field validation (HS-5062)', () => {
  test.skip(!PLUGINS_ENABLED, 'PLUGINS_ENABLED not set');

  let originalOwner = '';
  let originalRepo = '';
  let projectSecret = '';

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    projectSecret = projects[0]?.secret ?? '';

    // Remember the existing owner/repo so we can restore them after each test
    // (the tests save invalid values as a side effect of typing).
    const settingsRes = await request.get('/api/settings', {
      headers: projectSecret ? { 'X-Hotsheet-Secret': projectSecret } : {},
    });
    const settings = await settingsRes.json() as Record<string, string>;
    originalOwner = settings['plugin:github-issues:owner'] ?? '';
    originalRepo = settings['plugin:github-issues:repo'] ?? '';
  });

  test.afterEach(async ({ request }) => {
    // Restore owner/repo so the next test starts from a known state.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (projectSecret) headers['X-Hotsheet-Secret'] = projectSecret;
    await request.patch('/api/settings', {
      headers,
      data: {
        'plugin:github-issues:owner': originalOwner,
        'plugin:github-issues:repo': originalRepo,
      },
    });
  });

  /** Open the plugin config dialog for github-issues. */
  async function openConfigDialog(page: Page) {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#settings-btn').click();
    await page.locator('.settings-tab[data-tab="plugins"]').click();
    const githubRow = page.locator('.plugin-row', { hasText: 'GitHub Issues' });
    await expect(githubRow).toBeVisible({ timeout: 15000 });
    await githubRow.locator('.plugin-configure-btn').click();
    const dialog = page.locator('.custom-view-editor-overlay').last();
    await expect(dialog).toBeVisible({ timeout: 3000 });
    return dialog;
  }

  /** Type into a field inside a plugin-pref-row, wait past the 500ms debounce, and
   *  return the validation element for that field. */
  async function typeIntoFieldAndGetValidation(
    dialog: ReturnType<Page['locator']>,
    labelText: string,
    value: string,
  ) {
    const row = dialog.locator('.plugin-pref-row', { hasText: labelText });
    const input = row.locator('input[type="text"], input[type="password"]').first();
    await input.click();
    await input.fill('');
    await input.fill(value);
    // The debounce is 500ms; also the validate API call itself needs time.
    // Poll the validation element until it has a non-empty class beyond
    // 'plugin-pref-validation' alone, up to ~3s.
    const validation = row.locator('.plugin-pref-validation');
    await expect(validation).not.toHaveClass(/^plugin-pref-validation$/, { timeout: 3000 });
    return validation;
  }

  test('owner field: empty value shows error', async ({ page }) => {
    const dialog = await openConfigDialog(page);
    const row = dialog.locator('.plugin-pref-row', { hasText: 'Repository Owner' });
    const input = row.locator('input[type="text"]').first();
    await input.click();
    await input.fill('');
    // Don't type anything else — validate the empty state.
    const validation = row.locator('.plugin-pref-validation');
    await expect(validation).toHaveClass(/error/, { timeout: 3000 });
    await expect(validation).toContainText('Required');
  });

  test('owner field: value with spaces shows error', async ({ page }) => {
    const dialog = await openConfigDialog(page);
    const validation = await typeIntoFieldAndGetValidation(dialog, 'Repository Owner', 'has spaces');
    await expect(validation).toHaveClass(/error/);
    await expect(validation).toContainText(/spaces/i);
  });

  test('repo field: value with spaces shows error', async ({ page }) => {
    const dialog = await openConfigDialog(page);
    const validation = await typeIntoFieldAndGetValidation(dialog, 'Repository Name', 'bad name');
    await expect(validation).toHaveClass(/error/);
    await expect(validation).toContainText(/spaces/i);
  });

  test('token field: wrong prefix shows warning', async ({ page, request }) => {
    // Token is a global-scoped secret. Save the original and restore after.
    const globalRes = await request.get('/api/plugins/github-issues/global-config/token', {
      headers: projectSecret ? { 'X-Hotsheet-Secret': projectSecret } : {},
    });
    const originalToken = (await globalRes.json() as { value: string | null }).value ?? '';

    try {
      const dialog = await openConfigDialog(page);
      const validation = await typeIntoFieldAndGetValidation(
        dialog, 'Personal Access Token', 'not-a-valid-prefix',
      );
      await expect(validation).toHaveClass(/warning/);
      await expect(validation).toContainText(/ghp_|github_pat_/);
    } finally {
      // Restore the real token
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (projectSecret) headers['X-Hotsheet-Secret'] = projectSecret;
      await request.post('/api/plugins/github-issues/global-config', {
        headers, data: { key: 'token', value: originalToken },
      });
    }
  });

  test('token field: valid fine-grained prefix shows success', async ({ page, request }) => {
    const globalRes = await request.get('/api/plugins/github-issues/global-config/token', {
      headers: projectSecret ? { 'X-Hotsheet-Secret': projectSecret } : {},
    });
    const originalToken = (await globalRes.json() as { value: string | null }).value ?? '';

    try {
      const dialog = await openConfigDialog(page);
      const validation = await typeIntoFieldAndGetValidation(
        dialog, 'Personal Access Token', 'github_pat_fake_test_token_for_validation',
      );
      await expect(validation).toHaveClass(/success/);
    } finally {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (projectSecret) headers['X-Hotsheet-Secret'] = projectSecret;
      await request.post('/api/plugins/github-issues/global-config', {
        headers, data: { key: 'token', value: originalToken },
      });
    }
  });
});
