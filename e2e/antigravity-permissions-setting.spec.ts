import { expect, test } from './coverage-fixture.js';

/**
 * HS-9328 — the Settings → General "Interactive permission prompts (Antigravity)"
 * checkbox (`antigravity_interactive_permissions`). It is REVEALED only when the
 * AI-tool dropdown is set to Antigravity; toggling it persists to settings.json
 * (read back via /api/file-settings — the SAME key `antigravityDrive.ts` and
 * `skills.ts::ensureAntigravityHooks` read to drop `--dangerously-skip-permissions`
 * + install the PreToolUse hook) and restores after a full reload. Drives the real
 * UI. The setting → drive/hook behavior itself is unit-tested in
 * antigravityDrive.test.ts + skillsAntigravity.test.ts.
 */
test.describe('Antigravity interactive-permissions setting (HS-9328)', () => {
  test('checkbox reveals for Antigravity, persists, and restores on reload', async ({ page, request }) => {
    const readSettings = async (): Promise<{ ai_tool?: string; antigravity_interactive_permissions?: boolean }> =>
      await request.get('/api/file-settings').then((r) => r.json()) as { ai_tool?: string; antigravity_interactive_permissions?: boolean };
    const readTool = async (): Promise<string | undefined> => (await readSettings()).ai_tool;
    const readFlag = async (): Promise<boolean | undefined> => (await readSettings()).antigravity_interactive_permissions;

    // HS-9411 (docs/124) — `antigravity` is hidden from the AI-tool dropdown until
    // its In Development gate is on. This spec drives that dropdown, so opt in
    // first; `e2e/in-development-gates.spec.ts` owns the gate-off assertions.
    const projects = await request.get('/api/projects').then(r => r.json()) as { secret: string }[];
    const gateHeaders = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
    await request.patch('/api/file-settings/layer', {
      headers: gateHeaders, data: { layer: 'local', settings: { dev_tool_antigravity: true } },
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible();

    const field = page.locator('#antigravity-perms-field');
    const checkbox = page.locator('#settings-antigravity-interactive-permissions');
    const aiSelect = page.locator('#ai-tool-select');

    // Hidden until Antigravity is selected. (Each dropdown change persists ai_tool
    // async — poll it to land before the next change so they can't race/reorder.)
    await expect(field).toBeHidden();
    await aiSelect.selectOption('antigravity');
    await expect(field).toBeVisible();
    await expect(checkbox).not.toBeChecked(); // default off
    await expect.poll(readTool, { timeout: 5000 }).toBe('antigravity');

    // Switching to another tool hides it again.
    await aiSelect.selectOption('claude');
    await expect(field).toBeHidden();
    await expect.poll(readTool, { timeout: 5000 }).toBe('claude');

    // Back to Antigravity + enable → persists to settings.json.
    await aiSelect.selectOption('antigravity');
    await expect(field).toBeVisible();
    await expect.poll(readTool, { timeout: 5000 }).toBe('antigravity');
    await checkbox.check();
    await expect.poll(readFlag, { timeout: 5000 }).toBe(true);

    // Restores (tool selected + box checked) after a full reload.
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#settings-btn').click();
    await expect(page.locator('#ai-tool-select')).toHaveValue('antigravity', { timeout: 5000 });
    await expect(page.locator('#antigravity-perms-field')).toBeVisible();
    await expect(page.locator('#settings-antigravity-interactive-permissions')).toBeChecked();

    // Cleanup — reset so the shared server's project doesn't carry this into other specs.
    await page.locator('#settings-antigravity-interactive-permissions').uncheck();
    await expect.poll(readFlag, { timeout: 5000 }).toBe(false);
    await page.locator('#ai-tool-select').selectOption('auto');
    // Restore the shipped default (gate off) so later specs see it.
    await request.patch('/api/file-settings/layer', {
      headers: gateHeaders, data: { layer: 'local', settings: { dev_tool_antigravity: false } },
    });
  });
});
