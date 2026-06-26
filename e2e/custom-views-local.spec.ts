import { expect, test } from './coverage-fixture.js';

// HS-9092 (docs/107) — sidebar custom-view local customization: adding a view is
// LOCAL by default (never touches the committed settings.json), shared vs local
// views carry an origin badge, and a shared view can be hidden on this machine
// (local `hidden` delta) with an Undo.
test.describe('Custom views — sidebar local customization (HS-9092)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    // Dismiss the first-launch AI-instructions nudge overlay if present.
    await page.waitForTimeout(500);
    await page.evaluate(() => document.querySelectorAll('.ai-instructions-nudge-overlay').forEach(el => el.remove()));
    // Seed a SHARED custom view, then reload so the sidebar loads it.
    await page.request.patch('/api/file-settings/layer', {
      data: { layer: 'shared', settings: { custom_views: [
        { id: 'shared-view', name: 'Shared View', logic: 'all', conditions: [] },
      ] } },
      headers: { Origin: page.url().replace(/\/[^/]*$/, '') },
    });
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('adding a view is LOCAL by default — settings.json untouched, settings.local.json holds the added delta', async ({ page }) => {
    const container = page.locator('#custom-views-container');
    await expect(container.locator('.sidebar-custom-view', { hasText: 'Shared View' })).toBeVisible({ timeout: 5000 });

    // Add a view via the sidebar "+".
    await page.locator('#add-custom-view-btn').click();
    const editor = page.locator('.custom-view-editor-overlay');
    await expect(editor).toBeVisible({ timeout: 3000 });
    await editor.locator('#cv-name').fill('My Local View');
    await editor.locator('#cv-save').click();
    await expect(editor).toBeHidden({ timeout: 3000 });
    await page.waitForTimeout(400);

    const layered = await (await page.request.get('/api/file-settings/layered')).json() as {
      shared: Record<string, unknown>; local: Record<string, unknown>;
    };
    // Shared layer still has only the seeded shared view (the local add did NOT commit).
    expect((layered.shared.custom_views as { id: string }[]).map(v => v.id)).toEqual(['shared-view']);
    // The new view lives in the local delta's `added`.
    const localViews = layered.local.custom_views as { added?: { name: string }[] } | undefined;
    expect(localViews?.added?.some(v => v.name === 'My Local View')).toBe(true);

    // Both rows render with origin badges (local customization now exists).
    await expect(container.locator('.sidebar-custom-view', { hasText: 'Shared View' }).locator('.cv-layer-shared')).toBeVisible();
    await expect(container.locator('.sidebar-custom-view', { hasText: 'My Local View' }).locator('.cv-layer-local')).toBeVisible();
  });

  test('hide a shared view on this machine writes a local hidden delta; Undo restores it', async ({ page }) => {
    const container = page.locator('#custom-views-container');
    const row = container.locator('.sidebar-custom-view', { hasText: 'Shared View' });
    await expect(row).toBeVisible({ timeout: 5000 });

    // Right-click → "Hide on this machine".
    await row.click({ button: 'right' });
    await page.getByText('Hide on this machine').click();
    await expect(row).toBeHidden({ timeout: 3000 });
    await page.waitForTimeout(400); // let the local-layer write land

    // Local layer holds the hidden delta; shared is untouched.
    let layered = await (await page.request.get('/api/file-settings/layered')).json() as {
      shared: Record<string, unknown>; local: Record<string, unknown>;
    };
    expect((layered.local.custom_views as { hidden?: string[] }).hidden).toContain('shared-view');
    expect((layered.shared.custom_views as { id: string }[]).map(v => v.id)).toEqual(['shared-view']);

    // Undo from the toast restores it (local delta cleared).
    await page.locator('.hs-toast-action', { hasText: 'Undo' }).click();
    await expect(container.locator('.sidebar-custom-view', { hasText: 'Shared View' })).toBeVisible({ timeout: 3000 });
    await page.waitForTimeout(400);
    layered = await (await page.request.get('/api/file-settings/layered')).json() as {
      shared: Record<string, unknown>; local: Record<string, unknown>;
    };
    const local = layered.local.custom_views as { hidden?: string[] } | undefined;
    expect(local?.hidden ?? []).not.toContain('shared-view');
  });

  // HS-9093 — the Settings "Views" tab: add Local vs Shared lands in the right
  // file, and "Move to Local" promotes a shared view into the local layer.
  test('Settings Views tab: add Local/Shared lands in the right layer; Move to Local relocates a shared view', async ({ page }) => {
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
    await page.locator('.settings-tab[data-tab="views"]').click();
    const list = page.locator('#settings-views-list');
    await expect(list.locator('.settings-view-row', { hasText: 'Shared View' })).toBeVisible({ timeout: 5000 });

    // Add a SHARED view via the tab's "+ Add Shared".
    await page.locator('#settings-views-add-shared-btn').click();
    const editor = page.locator('.custom-view-editor-overlay');
    await expect(editor).toBeVisible({ timeout: 3000 });
    await editor.locator('#cv-name').fill('Tab Shared View');
    await editor.locator('#cv-save').click();
    await expect(editor).toBeHidden({ timeout: 3000 });
    await page.waitForTimeout(400);

    let layered = await (await page.request.get('/api/file-settings/layered')).json() as {
      shared: Record<string, unknown>; local: Record<string, unknown>;
    };
    // It went to the SHARED array (committed), not the local delta.
    expect((layered.shared.custom_views as { name: string }[]).some(v => v.name === 'Tab Shared View')).toBe(true);

    // Move the original shared view to Local via its row action.
    const row = list.locator('.settings-view-row', { hasText: 'Shared View' }).first();
    await row.locator('button[title^="Move to Local"]').click();
    await page.waitForTimeout(400);

    layered = await (await page.request.get('/api/file-settings/layered')).json() as {
      shared: Record<string, unknown>; local: Record<string, unknown>;
    };
    // shared-view physically left settings.json and became a local addition.
    expect((layered.shared.custom_views as { id: string }[]).map(v => v.id)).not.toContain('shared-view');
    expect((layered.local.custom_views as { added?: { id: string }[] }).added?.some(v => v.id === 'shared-view')).toBe(true);
  });
});
