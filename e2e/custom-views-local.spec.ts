import { expect, test } from './coverage-fixture.js';

// HS-9092 (docs/107) — sidebar custom-view local customization: adding a view is
// LOCAL by default (never touches the committed settings.json), and a shared view
// can be hidden on this machine (local `hidden` delta) with an Undo. (HS-9122
// removed the sidebar shared/local origin badges.)
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

    // HS-9122 — the sidebar no longer shows shared/local origin badges (the
    // distinction is managed on the Views settings tab instead).
    await expect(container.locator('.sidebar-custom-view .cv-layer-badge')).toHaveCount(0);
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

  // HS-9123 — the Settings "Views" tab is driven by the scope bar: one Add button
  // (targets the active layer), Shared shows only shared views, Move to Local
  // promotes a shared view into the local layer.
  test('HS-9123: Views tab uses the scope bar — one Add targets the active layer; Move to Local relocates a shared view', async ({ page }) => {
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
    await page.locator('.settings-tab[data-tab="views"]').click();
    const list = page.locator('#settings-views-list');
    await expect(list.locator('.settings-view-row', { hasText: 'Shared View' })).toBeVisible({ timeout: 5000 });

    // Switch to Shared mode → the single Add button relabels to "+ Add Shared View".
    await page.locator('.scope-seg-btn.scope-seg-shared').click();
    const addBtn = page.locator('#settings-views-add-btn');
    await expect(addBtn).toHaveText('+ Add Shared View', { timeout: 3000 });
    await addBtn.click();
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

    // Move the original shared view to Local via its row action (Shared mode shows it).
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

  // HS-9187 — editing a shared view in Local mode customizes it on this machine
  // (a local `overrides` entry, not a mutation of the team value) and the row
  // gains an undo-2 "reset to shared" button that restores the shared value.
  test('HS-9187: a Local-mode edit of a shared view is an override with a reset-to-shared button', async ({ page }) => {
    type Layered = { shared: { custom_views: { id: string; name: string }[] }; local: { custom_views?: { overrides?: Record<string, { name?: string }> } } };
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
    await page.locator('.settings-tab[data-tab="views"]').click();
    await page.locator('.scope-seg-btn.scope-seg-local').click();
    const list = page.locator('#settings-views-list');
    const sharedRow = list.locator('.settings-view-row', { hasText: 'Shared View' }).first();
    await expect(sharedRow).toBeVisible({ timeout: 5000 });
    await expect(sharedRow.locator('.view-reset-btn')).toHaveCount(0); // not overridden yet

    // Edit it in Local mode → a local override (shared/team value untouched).
    await sharedRow.locator('button[title="Edit"]').click();
    const editor = page.locator('.custom-view-editor-overlay');
    await expect(editor).toBeVisible({ timeout: 3000 });
    await editor.locator('#cv-name').fill('Shared View (local)');
    await editor.locator('#cv-save').click();
    await expect(editor).toBeHidden({ timeout: 3000 });
    await page.waitForTimeout(400);

    let layered = await (await page.request.get('/api/file-settings/layered')).json() as Layered;
    expect(layered.shared.custom_views.find(v => v.id === 'shared-view')?.name).toBe('Shared View'); // team value intact
    expect(layered.local.custom_views?.overrides?.['shared-view']?.name).toBe('Shared View (local)');

    // The overridden row now offers the reset-to-shared button.
    const overriddenRow = list.locator('.settings-view-row', { hasText: 'Shared View (local)' }).first();
    await expect(overriddenRow.locator('.view-reset-btn')).toHaveCount(1);

    // Reset → the override is dropped and the name reverts to the shared value.
    await overriddenRow.locator('.view-reset-btn').click();
    await page.waitForTimeout(400);
    layered = await (await page.request.get('/api/file-settings/layered')).json() as Layered;
    expect(layered.local.custom_views?.overrides?.['shared-view']).toBeUndefined();
    await expect(list.locator('.settings-view-row', { hasText: 'Shared View (local)' })).toHaveCount(0);
  });

  // HS-9123 — shared views can now be deleted outright from the Views tab.
  test('HS-9123: a shared view can be deleted from the Views tab', async ({ page }) => {
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
    await page.locator('.settings-tab[data-tab="views"]').click();
    await page.locator('.scope-seg-btn.scope-seg-shared').click();
    const list = page.locator('#settings-views-list');
    const row = list.locator('.settings-view-row', { hasText: 'Shared View' }).first();
    await expect(row).toBeVisible({ timeout: 5000 });

    await row.locator('.cmd-outline-delete-btn').click();
    const confirmBtn = page.locator('.confirm-dialog-confirm');
    await expect(confirmBtn).toBeVisible({ timeout: 3000 });
    await confirmBtn.click();
    await page.waitForTimeout(400);

    const layered = await (await page.request.get('/api/file-settings/layered')).json() as { shared: Record<string, unknown> };
    expect((layered.shared.custom_views as { id: string }[]).map(v => v.id)).not.toContain('shared-view');
  });
});
