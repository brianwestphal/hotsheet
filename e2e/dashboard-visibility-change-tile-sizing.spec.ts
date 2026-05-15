/**
 * HS-8399 — Regression coverage for "changing visibility in terminal
 * dashboard makes all terminals very small (0×0)".
 *
 * User-reported repro: dashboard open with multiple terminals visible →
 * toggle a terminal's visibility (Show / Hide Terminals dialog, or the
 * visibility-grouping <select>) → the surviving tiles collapse to 0×0
 * (no inline `width` applied). Closing + reopening the dashboard
 * recovers because `renderDashboardGrid` re-runs paint against an
 * already-attached root.
 *
 * Root cause analysis (see ticket notes): `paintDashboardSections`
 * disposes the prior gridHandles, runs `root.replaceChildren()`, mounts
 * fresh handles, and re-runs `applyAllSizing()`. If `applySizing` lands
 * against a container whose `clientWidth === 0` (transiently between
 * the replaceChildren and the browser settling layout), the early-bail
 * at `terminalTileGrid.tsx:909` (`if (rootWidth <= 0) return;`) leaves
 * tiles with no inline width and no CSS-side fallback width — they
 * collapse to content width (≈0).
 *
 * The unit-level happy-dom tests in `terminalTileGrid.test.ts` cover
 * the dispose / re-mount / rebuild sequence and pass — but happy-dom's
 * synchronous layout doesn't reproduce the real-browser race. This
 * spec drives the same sequence in Chromium and asserts every visible
 * tile has positive offsetWidth + offsetHeight after the hidden-state
 * change.
 *
 * Tauri stub mirrors `e2e/terminal-dashboard.spec.ts` — the dashboard
 * is Tauri-only per §25.11.
 */
import type { APIRequestContext, Page } from '@playwright/test';

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
      drawer_open: 'false',
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

/** Snapshot every visible dashboard tile's offsetWidth / offsetHeight +
 *  the inline width attribute the sizing pass writes. Returned as an
 *  array of objects so assertion failures point at the specific tile. */
async function snapshotTileDims(page: Page): Promise<
  { id: string; offsetWidth: number; offsetHeight: number; inlineWidth: string }[]
> {
  // Wait for two animation frames before sampling — paintDashboardSections
  // queues a defensive `requestAnimationFrame(applyAllSizing)` after its
  // synchronous sizing pass (HS-8399). Sampling on rAF #1 reads the tile
  // dims AFTER that callback has executed.
  return page.evaluate(() => new Promise<
    { id: string; offsetWidth: number; offsetHeight: number; inlineWidth: string }[]
  >((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const tiles = Array.from(document.querySelectorAll<HTMLElement>('.terminal-dashboard-tile'));
        resolve(tiles.map((tile) => ({
          id: tile.dataset.terminalId ?? '',
          offsetWidth: tile.offsetWidth,
          offsetHeight: tile.offsetHeight,
          inlineWidth: tile.style.width,
        })));
      });
    });
  }));
}

test.describe('HS-8399 — visibility change in dashboard preserves tile sizing', () => {
  test.beforeAll(async ({ request }) => {
    await fetchHeaders(request);
  });

  test.beforeEach(async ({ page, request }) => {
    await stubTauri(page);
    await purgeDynamic(request);
  });

  test('hiding a tile via the Show/Hide dialog keeps every surviving tile at non-zero size', async ({ page, request }) => {
    await seedTerminals(request, [
      { id: 'a', name: 'A', command: '/bin/echo a' },
      { id: 'b', name: 'B', command: '/bin/echo b' },
      { id: 'c', name: 'C', command: '/bin/echo c' },
      { id: 'd', name: 'D', command: '/bin/echo d' },
    ]);

    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Enter the dashboard and wait for all 4 tiles to render.
    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);
    for (const id of ['a', 'b', 'c', 'd']) {
      await expect(page.locator(`.terminal-dashboard-tile[data-terminal-id="${id}"]`)).toHaveCount(1, { timeout: 5000 });
    }

    // Baseline — every tile has positive offsetWidth + inline width.
    const before = await snapshotTileDims(page);
    expect(before).toHaveLength(4);
    for (const t of before) {
      expect.soft(t.offsetWidth, `baseline tile ${t.id} offsetWidth`).toBeGreaterThan(0);
      expect.soft(t.offsetHeight, `baseline tile ${t.id} offsetHeight`).toBeGreaterThan(0);
      expect.soft(t.inlineWidth, `baseline tile ${t.id} inline width`).not.toBe('');
    }

    // Hide one terminal via the dialog — this is the exact flow the user
    // reported. `setTerminalHidden` fires the hidden-change subscription
    // which `paintDashboardSections` listens for; the dashboard tears
    // down + rebuilds the grid handles in place.
    const hideBtn = page.locator('#terminal-dashboard-hide-btn, .terminal-dashboard-hide-btn').first();
    await hideBtn.click();
    const dialog = page.locator('.hide-terminal-dialog-overlay');
    await expect(dialog).toBeVisible();
    await dialog.locator('.hide-terminal-row[data-terminal-id="b"]').click();
    await page.keyboard.press('Escape');

    // Tile B is gone; A, C, D survive. The user-reported regression
    // is that A / C / D drop to 0×0 inline width at this point.
    await expect(page.locator('.terminal-dashboard-tile[data-terminal-id="b"]')).toHaveCount(0, { timeout: 5000 });
    for (const id of ['a', 'c', 'd']) {
      await expect(page.locator(`.terminal-dashboard-tile[data-terminal-id="${id}"]`)).toHaveCount(1);
    }

    const after = await snapshotTileDims(page);
    expect(after).toHaveLength(3);
    for (const t of after) {
      expect.soft(t.offsetWidth, `post-hide tile ${t.id} offsetWidth (inline="${t.inlineWidth}")`).toBeGreaterThan(0);
      expect.soft(t.offsetHeight, `post-hide tile ${t.id} offsetHeight`).toBeGreaterThan(0);
      expect.soft(t.inlineWidth, `post-hide tile ${t.id} inline width must be applied by paintDashboardSections' second-pass applyAllSizing`).not.toBe('');
    }
  });

  test('repeatedly toggling hide/show keeps every surviving tile at non-zero size (re-paint stress)', async ({ page, request }) => {
    await seedTerminals(request, [
      { id: 'a', name: 'A', command: '/bin/echo a' },
      { id: 'b', name: 'B', command: '/bin/echo b' },
      { id: 'c', name: 'C', command: '/bin/echo c' },
    ]);

    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);
    for (const id of ['a', 'b', 'c']) {
      await expect(page.locator(`.terminal-dashboard-tile[data-terminal-id="${id}"]`)).toHaveCount(1, { timeout: 5000 });
    }

    const hideBtn = page.locator('#terminal-dashboard-hide-btn, .terminal-dashboard-hide-btn').first();

    // Cycle: hide B → show B → hide C → show C → hide A → show A. Each
    // toggle triggers a full paintDashboardSections re-paint (dispose +
    // replaceChildren + mount + rebuild + applyAllSizing). The bug
    // manifests intermittently against the layout race, so several
    // iterations raise the catch rate.
    for (const targetId of ['b', 'c', 'a']) {
      await hideBtn.click();
      const dialog = page.locator('.hide-terminal-dialog-overlay');
      await expect(dialog).toBeVisible();
      await dialog.locator(`.hide-terminal-row[data-terminal-id="${targetId}"]`).click();
      await page.keyboard.press('Escape');
      await expect(page.locator(`.terminal-dashboard-tile[data-terminal-id="${targetId}"]`)).toHaveCount(0, { timeout: 5000 });

      const afterHide = await snapshotTileDims(page);
      for (const t of afterHide) {
        expect.soft(t.offsetWidth, `after hiding ${targetId}: tile ${t.id} offsetWidth (inline="${t.inlineWidth}")`).toBeGreaterThan(0);
        expect.soft(t.inlineWidth, `after hiding ${targetId}: tile ${t.id} inline width`).not.toBe('');
      }

      // Restore by clicking Show all.
      await hideBtn.click();
      await expect(dialog).toBeVisible();
      await dialog.locator('.hide-terminal-show-all').click();
      await page.keyboard.press('Escape');
      await expect(page.locator(`.terminal-dashboard-tile[data-terminal-id="${targetId}"]`)).toHaveCount(1, { timeout: 5000 });

      const afterShow = await snapshotTileDims(page);
      expect(afterShow).toHaveLength(3);
      for (const t of afterShow) {
        expect.soft(t.offsetWidth, `after re-showing ${targetId}: tile ${t.id} offsetWidth (inline="${t.inlineWidth}")`).toBeGreaterThan(0);
        expect.soft(t.inlineWidth, `after re-showing ${targetId}: tile ${t.id} inline width`).not.toBe('');
      }
    }
  });

  test('switching the active visibility grouping from the dashboard dropdown keeps every visible tile sized', async ({ page, request }) => {
    await seedTerminals(request, [
      { id: 'a', name: 'A', command: '/bin/echo a' },
      { id: 'b', name: 'B', command: '/bin/echo b' },
      { id: 'c', name: 'C', command: '/bin/echo c' },
      { id: 'd', name: 'D', command: '/bin/echo d' },
    ]);

    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Create a second visibility grouping via the in-app helpers. The
    // `dashboardHiddenTerminals` module is the public surface for the
    // groupings state; reaching in via window-exposed shims (or via
    // the dialog UI) is required because §39 doesn't expose a server-
    // side grouping CRUD endpoint — it's all client-side persisted
    // state synced via the file-settings PATCH.
    //
    // The dialog flow: open the hide-terminal dialog, click the "+" tab
    // to add a new grouping named "Hide A+B", hide A + B inside that
    // grouping, then dismiss. The dashboard's `<select>` now offers
    // two groupings.
    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);
    for (const id of ['a', 'b', 'c', 'd']) {
      await expect(page.locator(`.terminal-dashboard-tile[data-terminal-id="${id}"]`)).toHaveCount(1, { timeout: 5000 });
    }

    const hideBtn = page.locator('#terminal-dashboard-hide-btn, .terminal-dashboard-hide-btn').first();
    await hideBtn.click();
    const dialog = page.locator('.hide-terminal-dialog-overlay');
    await expect(dialog).toBeVisible();

    // Add a new grouping via the +tab button. The §39 dialog renders a
    // `.hide-terminal-tab-add` button at the end of the grouping-tab
    // strip; clicking it opens a `.grouping-prompt-overlay` where the
    // user types the new grouping's name.
    const addTabBtn = dialog.locator('.hide-terminal-tab-add').first();
    await expect(addTabBtn).toBeVisible({ timeout: 5000 });
    await addTabBtn.click();

    const promptOverlay = page.locator('.grouping-prompt-overlay');
    await expect(promptOverlay).toBeVisible({ timeout: 3000 });
    await promptOverlay.locator('.grouping-prompt-input').fill('Hide A and B');
    await promptOverlay.locator('[data-action="ok"]').click();
    await expect(promptOverlay).toHaveCount(0);

    // The new tab is auto-selected; hide A + B inside it.
    await dialog.locator('.hide-terminal-row[data-terminal-id="a"]').click();
    await dialog.locator('.hide-terminal-row[data-terminal-id="b"]').click();
    await page.keyboard.press('Escape');

    // The dashboard's grouping <select> reveals itself once a second
    // grouping exists.
    const groupingSelect = page.locator('#terminal-dashboard-grouping-select');
    await expect(groupingSelect).toBeVisible({ timeout: 5000 });

    // Snapshot pre-switch tiles (the new grouping is active because
    // adding a tab auto-selects it). A + B are hidden, C + D survive.
    await expect(page.locator('.terminal-dashboard-tile[data-terminal-id="a"]')).toHaveCount(0);
    await expect(page.locator('.terminal-dashboard-tile[data-terminal-id="b"]')).toHaveCount(0);
    const preSwitch = await snapshotTileDims(page);
    for (const t of preSwitch) {
      expect.soft(t.offsetWidth, `pre-switch tile ${t.id} offsetWidth`).toBeGreaterThan(0);
      expect.soft(t.inlineWidth, `pre-switch tile ${t.id} inline width`).not.toBe('');
    }

    // Switch back to the Default grouping via the <select>. This is
    // the exact user-reported flow: changing the visibility selection
    // in the dashboard chrome. The change handler calls
    // `setActiveGrouping(DASHBOARD_SCOPE, ...)` which fires the hidden-
    // change subscription which re-paints the sections.
    await groupingSelect.selectOption('default');

    // All 4 tiles should now be visible (Default has nothing hidden).
    for (const id of ['a', 'b', 'c', 'd']) {
      await expect(page.locator(`.terminal-dashboard-tile[data-terminal-id="${id}"]`)).toHaveCount(1, { timeout: 5000 });
    }

    const postSwitch = await snapshotTileDims(page);
    expect(postSwitch).toHaveLength(4);
    for (const t of postSwitch) {
      expect.soft(t.offsetWidth, `post-grouping-switch tile ${t.id} offsetWidth (inline="${t.inlineWidth}")`).toBeGreaterThan(0);
      expect.soft(t.offsetHeight, `post-grouping-switch tile ${t.id} offsetHeight`).toBeGreaterThan(0);
      expect.soft(t.inlineWidth, `post-grouping-switch tile ${t.id} inline width`).not.toBe('');
    }
  });
});
