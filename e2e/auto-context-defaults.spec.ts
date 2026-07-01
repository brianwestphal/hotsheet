/**
 * HS-9247 — built-in categories ship with default auto-context. In Settings →
 * Context the default shows as a grayed placeholder for any category with no
 * user entry, and clicking it adopts the default as an editable entry pre-filled
 * with the default text (so the user customizes from it rather than retyping).
 *
 * The read-time merge + defaults are unit-tested (`src/autoContextDefaults.test.ts`,
 * `src/sync/markdown.test.ts`); this spec covers the Settings DOM wiring.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Auto-context built-in defaults (HS-9247)', () => {
  test('Bug default shows as a placeholder and pre-fills on click', async ({ page, request }) => {
    const projects = await (await request.get('/api/projects')).json() as { secret: string }[];
    const secret = projects[0]?.secret ?? '';
    // Clean slate: no user auto-context, so the built-in defaults surface.
    await request.patch('/api/file-settings', {
      headers: { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret },
      data: { auto_context: [] },
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
    await page.locator('.settings-tab[data-tab="context"]').click();
    await expect(page.locator('.settings-tab-panel[data-panel="context"]')).toHaveClass(/active/);

    // The Bug category's built-in default appears as a placeholder row.
    const bugDefaultRow = page.locator(
      '.auto-context-entry.auto-context-default:has(.auto-context-badge:has-text("Category: Bug"))',
    );
    await expect(bugDefaultRow).toBeVisible({ timeout: 3000 });
    const placeholderTa = bugDefaultRow.locator('.auto-context-text');
    await expect(placeholderTa).toHaveAttribute('placeholder', /Reproduce the bug first/);
    await expect(placeholderTa).toHaveValue('');

    // Clicking it adopts the default as an editable entry pre-filled with the text.
    await placeholderTa.click();
    const liveTa = page.locator('.auto-context-entry[data-ac-id="category:bug"] .auto-context-text');
    await expect(liveTa).toHaveValue(/Reproduce the bug first/, { timeout: 3000 });
  });
});
