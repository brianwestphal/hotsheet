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

    // HS-9517 (docs/133) — Antigravity is an `unreleased` integration, hidden from
    // the AI-tool dropdown behind the `dev_unreleased_ai_tools` dev gate + per-tool
    // enablement. Turn on the dev gate here so its enable checkbox is even listed;
    // the enablement itself is ticked in the UI below (that path mutates live
    // `state.settings`, so it survives the tool-switch churn this test does — an
    // API-only enable was silently lost on the second `selectOption`).
    const projects = await (await request.get('/api/projects')).json() as { secret: string }[];
    const headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
    await request.patch('/api/file-settings/layer', { headers, data: { layer: 'local', settings: { dev_unreleased_ai_tools: true } } });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible();
    // Enable Antigravity so the picker offers it (the dev gate above listed the box).
    await page.locator('#ai-tool-enabled-antigravity').check();

    // HS-9497 — the row is now RENDERED from the tool's plugin `preferences` declaration
    // rather than server-rendered and toggled with `display:none`, so for a non-selected
    // tool it is ABSENT rather than hidden. `toBeHidden()` covers both, and the
    // not-in-DOM assertion below is the stronger one.
    const field = page.locator('[data-pref-key="antigravity_interactive_permissions"]');
    const checkbox = page.locator('#settings-pref-antigravity_interactive_permissions');
    const aiSelect = page.locator('#ai-tool-select');

    // Hidden until Antigravity is selected. (Each dropdown change persists ai_tool
    // async — poll it to land before the next change so they can't race/reorder.)
    await expect(field).toHaveCount(0); // nothing rendered until Antigravity is selected
    await aiSelect.selectOption('antigravity');
    await expect(field).toBeVisible();
    await expect(checkbox).not.toBeChecked(); // default off
    await expect.poll(readTool, { timeout: 5000 }).toBe('antigravity');

    // Switching to another tool hides it again.
    await aiSelect.selectOption('claude');
    await expect(field).toHaveCount(0); // not merely hidden — Claude declares no preferences
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
    await expect(page.locator('[data-pref-key="antigravity_interactive_permissions"]')).toBeVisible();
    await expect(page.locator('#settings-pref-antigravity_interactive_permissions')).toBeChecked();

    // Cleanup — reset so the shared server's project doesn't carry this into other specs.
    await page.locator('#settings-pref-antigravity_interactive_permissions').uncheck();
    await expect.poll(readFlag, { timeout: 5000 }).toBe(false);
    await page.locator('#ai-tool-select').selectOption('auto');
    // Undo the HS-9517 enablement so the shared server returns to Claude-only.
    await page.locator('#ai-tool-enabled-antigravity').uncheck();
    await request.patch('/api/file-settings/layer', { headers, data: { layer: 'local', settings: { dev_unreleased_ai_tools: false } } });
  });
});
