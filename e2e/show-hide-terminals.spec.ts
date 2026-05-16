/**
 * HS-8356 — end-to-end coverage for showing / hiding terminals in BOTH
 * the §25 Terminal Dashboard view AND the §36 Drawer Terminal Grid
 * view, with screenshot artifacts at every key change moment.
 *
 * The drawer-terminal-grid spec (`e2e/drawer-terminal-grid.spec.ts`)
 * already covers eye-button → dialog → row-click → tile-disappears
 * for the drawer grid. This file extends that coverage with:
 *
 *   - Dashboard-view tests for the same flow (none exist today).
 *   - Cross-surface assertions: a hide in one view persists into the
 *     other view (both surfaces share the same active-grouping store).
 *   - Hide-button badge count assertions in both views.
 *   - "All Terminals Hidden" placeholder assertions in the dashboard.
 *   - Explicit `page.screenshot()` artifacts at the moment of state
 *     change so manual review can compare the pre / post visual.
 *
 * Playwright's `screenshot: 'only-on-failure'` in `playwright.config.ts`
 * also captures additional PNGs on any failed assertion.
 *
 * Note: this spec uses `addInitScript` to stub `window.__TAURI__` before
 * the bundle loads, matching the existing `e2e/terminal-dashboard.spec.ts`
 * + `e2e/drawer-terminal-grid.spec.ts` pattern — both surfaces are
 * Tauri-only per §25.11 / §36.8.
 */
import type { Page, APIRequestContext } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

let headers: Record<string, string> = {};

async function fetchHeaders(request: APIRequestContext): Promise<void> {
  const res = await request.get('/api/projects');
  const projects = await res.json() as { secret: string }[];
  headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
}

async function seedTerminals(
  request: APIRequestContext,
  terminals: { id: string; name: string; command: string; lazy?: boolean }[],
): Promise<void> {
  await request.patch('/api/file-settings', {
    headers,
    data: {
      terminal_enabled: 'true',
      drawer_open: 'true',
      terminals: terminals.map(t => ({ ...t, lazy: t.lazy ?? true })),
    },
  });
}

async function purgeDynamic(request: APIRequestContext): Promise<void> {
  try {
    const list = await (await request.get('/api/terminal/list', { headers })).json() as {
      dynamic?: { id: string }[];
    };
    for (const d of list.dynamic ?? []) {
      await request.post('/api/terminal/destroy', { headers, data: { terminalId: d.id } });
    }
  } catch { /* first-time setup */ }
}

async function stubTauri(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__TAURI__ = {
      core: { invoke: async () => undefined },
    };
  });
}

test.describe('HS-8356 — show / hide terminals in the dashboard view', () => {
  test.beforeAll(async ({ request }) => {
    await fetchHeaders(request);
  });

  test.beforeEach(async ({ page, request }) => {
    await stubTauri(page);
    await purgeDynamic(request);
  });

  test('opening the dashboard with multiple terminals shows every tile (baseline)', async ({ page, request }) => {
    await seedTerminals(request, [
      { id: 'a', name: 'A', command: '/bin/echo a' },
      { id: 'b', name: 'B', command: '/bin/echo b' },
      { id: 'c', name: 'C', command: '/bin/echo c' },
    ]);
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);

    // All three tiles render — `.terminal-dashboard-tile[data-terminal-id="X"]` is the
    // post-HS-7967 `flattenSectionsToTiles` layout.
    for (const id of ['a', 'b', 'c']) {
      await expect(page.locator(`.terminal-dashboard-tile[data-terminal-id="${id}"]`)).toHaveCount(1, { timeout: 5000 });
    }

    await page.screenshot({ path: 'test-results/hs-8356-dashboard-all-visible.png' });
  });

  test('clicking the hide button opens the Show / Hide Terminals dialog with every terminal listed', async ({ page, request }) => {
    await seedTerminals(request, [
      { id: 'a', name: 'A', command: '/bin/echo a' },
      { id: 'b', name: 'B', command: '/bin/echo b' },
    ]);
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();

    // The dashboard's hide button — find via id-based selectors used by
    // the rendering code in terminalDashboard.tsx.
    const hideBtn = page.locator('#terminal-dashboard-hide-btn, .terminal-dashboard-hide-btn').first();
    await expect(hideBtn).toBeVisible({ timeout: 5000 });
    await hideBtn.click();

    const dialog = page.locator('.hide-terminal-dialog-overlay');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.hide-terminal-row[data-terminal-id="a"]')).toHaveCount(1);
    await expect(dialog.locator('.hide-terminal-row[data-terminal-id="b"]')).toHaveCount(1);

    await page.screenshot({ path: 'test-results/hs-8356-dashboard-dialog-open.png' });

    // Close via Escape.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('hiding one terminal via the dialog drops its tile from the dashboard in place', async ({ page, request }) => {
    await seedTerminals(request, [
      { id: 'a', name: 'A', command: '/bin/echo a' },
      { id: 'b', name: 'B', command: '/bin/echo b' },
      { id: 'c', name: 'C', command: '/bin/echo c' },
    ]);
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('.terminal-dashboard-tile[data-terminal-id="b"]')).toHaveCount(1, { timeout: 5000 });

    const hideBtn = page.locator('#terminal-dashboard-hide-btn, .terminal-dashboard-hide-btn').first();
    await hideBtn.click();
    const dialog = page.locator('.hide-terminal-dialog-overlay');
    await expect(dialog).toBeVisible();
    await dialog.locator('.hide-terminal-row[data-terminal-id="b"]').click();
    await expect(dialog.locator('.hide-terminal-row[data-terminal-id="b"].is-hidden')).toHaveCount(1);

    // The dashboard rebuilt via the hidden-state subscription — tile B is gone.
    await expect(page.locator('.terminal-dashboard-tile[data-terminal-id="b"]')).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('.terminal-dashboard-tile[data-terminal-id="a"]')).toHaveCount(1);
    await expect(page.locator('.terminal-dashboard-tile[data-terminal-id="c"]')).toHaveCount(1);

    await page.screenshot({ path: 'test-results/hs-8356-dashboard-after-hide-one.png' });
  });

  test('hiding every terminal shows the "All Terminals Hidden" placeholder', async ({ page, request }) => {
    await seedTerminals(request, [
      { id: 'a', name: 'A', command: '/bin/echo a' },
      { id: 'b', name: 'B', command: '/bin/echo b' },
    ]);
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();
    // HS-8419 — wait for at least one tile to render before clicking the
    // hide button. The dialog reads `dashboardState.lastSectionData` which
    // is populated by the dashboard's first render; without this wait the
    // dialog can open against an empty `lastSectionData` and show the
    // "No terminals registered." empty-state.
    await expect(page.locator('.terminal-dashboard-tile[data-terminal-id="a"]')).toHaveCount(1, { timeout: 5000 });

    const hideBtn = page.locator('#terminal-dashboard-hide-btn, .terminal-dashboard-hide-btn').first();
    await hideBtn.click();
    const dialog = page.locator('.hide-terminal-dialog-overlay');
    await expect(dialog).toBeVisible();
    await dialog.locator('.hide-terminal-row[data-terminal-id="a"]').click();
    await dialog.locator('.hide-terminal-row[data-terminal-id="b"]').click();
    await page.keyboard.press('Escape');

    await expect(page.locator('.terminal-dashboard-all-hidden')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.terminal-dashboard-tile')).toHaveCount(0);

    await page.screenshot({ path: 'test-results/hs-8356-dashboard-all-hidden.png' });
  });

  test('Show all in the dialog restores every hidden tile', async ({ page, request }) => {
    await seedTerminals(request, [
      { id: 'a', name: 'A', command: '/bin/echo a' },
      { id: 'b', name: 'B', command: '/bin/echo b' },
    ]);
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();

    const hideBtn = page.locator('#terminal-dashboard-hide-btn, .terminal-dashboard-hide-btn').first();
    await hideBtn.click();
    const dialog = page.locator('.hide-terminal-dialog-overlay');
    await dialog.locator('.hide-terminal-row[data-terminal-id="a"]').click();
    await dialog.locator('.hide-terminal-row[data-terminal-id="b"]').click();
    await expect(page.locator('.terminal-dashboard-all-hidden')).toBeVisible();

    await dialog.locator('.hide-terminal-show-all').click();
    await expect(page.locator('.terminal-dashboard-tile[data-terminal-id="a"]')).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator('.terminal-dashboard-tile[data-terminal-id="b"]')).toHaveCount(1);
    await expect(page.locator('.terminal-dashboard-all-hidden')).toHaveCount(0);

    await page.screenshot({ path: 'test-results/hs-8356-dashboard-after-show-all.png' });
  });

  test('the hide button badge reflects the count of hidden terminals in the active grouping', async ({ page, request }) => {
    await seedTerminals(request, [
      { id: 'a', name: 'A', command: '/bin/echo a' },
      { id: 'b', name: 'B', command: '/bin/echo b' },
      { id: 'c', name: 'C', command: '/bin/echo c' },
    ]);
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();

    const hideBtn = page.locator('#terminal-dashboard-hide-btn, .terminal-dashboard-hide-btn').first();
    // No badge initially (count === 0).
    await expect(hideBtn.locator('.hide-btn-badge')).toHaveCount(0);

    await hideBtn.click();
    const dialog = page.locator('.hide-terminal-dialog-overlay');
    await dialog.locator('.hide-terminal-row[data-terminal-id="a"]').click();
    // Badge shows 1.
    await expect(hideBtn.locator('.hide-btn-badge')).toHaveText('1', { timeout: 5000 });
    await dialog.locator('.hide-terminal-row[data-terminal-id="b"]').click();
    // Badge shows 2.
    await expect(hideBtn.locator('.hide-btn-badge')).toHaveText('2', { timeout: 5000 });

    await dialog.locator('.hide-terminal-show-all').click();
    await expect(hideBtn.locator('.hide-btn-badge')).toHaveCount(0);
  });
});

test.describe('HS-8356 — show / hide terminals cross-surface (dashboard ↔ drawer grid)', () => {
  test.beforeAll(async ({ request }) => {
    await fetchHeaders(request);
  });

  test.beforeEach(async ({ page, request }) => {
    await stubTauri(page);
    await purgeDynamic(request);
  });

  test('hiding a terminal in the dashboard persists into the drawer grid view (single active-grouping source of truth)', async ({ page, request }) => {
    await seedTerminals(request, [
      { id: 'a', name: 'A', command: '/bin/echo a' },
      { id: 'b', name: 'B', command: '/bin/echo b' },
      { id: 'c', name: 'C', command: '/bin/echo c' },
    ]);
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 5000 });

    // 1. Hide terminal B from the dashboard.
    await page.locator('#terminal-dashboard-toggle').click();
    const dashHide = page.locator('#terminal-dashboard-hide-btn, .terminal-dashboard-hide-btn').first();
    await dashHide.click();
    await page.locator('.hide-terminal-dialog-overlay .hide-terminal-row[data-terminal-id="b"]').click();
    await page.keyboard.press('Escape');
    // Confirm the dashboard reflects the hide.
    await expect(page.locator('.terminal-dashboard-tile[data-terminal-id="b"]')).toHaveCount(0, { timeout: 5000 });

    // 2. Exit dashboard mode, enter drawer grid mode.
    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(0);
    const drawerToggle = page.locator('#drawer-grid-toggle');
    await expect(drawerToggle).toBeEnabled({ timeout: 5000 });
    await drawerToggle.click();
    await expect(page.locator('#drawer-terminal-grid')).toBeVisible();

    // 3. Drawer grid also has B hidden (same active grouping).
    await expect(page.locator('.drawer-terminal-grid-tile[data-terminal-id="b"]')).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('.drawer-terminal-grid-tile[data-terminal-id="a"]')).toHaveCount(1);
    await expect(page.locator('.drawer-terminal-grid-tile[data-terminal-id="c"]')).toHaveCount(1);

    await page.screenshot({ path: 'test-results/hs-8356-cross-surface-drawer-after-dashboard-hide.png' });
  });

  test('hiding a terminal in the drawer grid persists into the dashboard view', async ({ page, request }) => {
    await seedTerminals(request, [
      { id: 'a', name: 'A', command: '/bin/echo a' },
      { id: 'b', name: 'B', command: '/bin/echo b' },
      { id: 'c', name: 'C', command: '/bin/echo c' },
    ]);
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 5000 });

    // 1. Hide terminal A via the drawer grid.
    const drawerToggle = page.locator('#drawer-grid-toggle');
    await expect(drawerToggle).toBeEnabled({ timeout: 5000 });
    await drawerToggle.click();
    await expect(page.locator('#drawer-terminal-grid')).toBeVisible();
    await page.locator('#drawer-grid-hide-btn').click();
    await page.locator('.hide-terminal-dialog-overlay .hide-terminal-row[data-terminal-id="a"]').click();
    await page.keyboard.press('Escape');
    // Confirm the drawer grid reflects the hide.
    await expect(page.locator('.drawer-terminal-grid-tile[data-terminal-id="a"]')).toHaveCount(0, { timeout: 5000 });

    // 2. Exit drawer grid, enter dashboard.
    await drawerToggle.click();
    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);

    // 3. Dashboard also has A hidden.
    await expect(page.locator('.terminal-dashboard-tile[data-terminal-id="a"]')).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('.terminal-dashboard-tile[data-terminal-id="b"]')).toHaveCount(1);
    await expect(page.locator('.terminal-dashboard-tile[data-terminal-id="c"]')).toHaveCount(1);

    await page.screenshot({ path: 'test-results/hs-8356-cross-surface-dashboard-after-drawer-hide.png' });
  });
});
