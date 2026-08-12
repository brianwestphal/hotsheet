/**
 * HS-9627 — the terminal dashboard restores its scroll position (best effort)
 * when you switch away and come back.
 *
 * The dashboard scroll container (`#terminal-dashboard-root`) is fully torn
 * down on exit and rebuilt on re-enter, so before the fix `scrollTop` always
 * snapped back to 0 on return. This spec drives the real user flow: seed enough
 * terminals + a 1-column layout to force the grid to overflow a short viewport,
 * scroll down, leave the dashboard, come back, and assert we landed back near
 * where we were — not at the top.
 */
import { expect, test } from './coverage-fixture.js';

let headers: Record<string, string> = {};

// Eight lazy (cold-placeholder) terminals — no PTYs to spawn, but each still
// renders a real tile with real dimensions. Stacked at 1 column they overflow
// a short viewport deterministically.
const TERMINALS = Array.from({ length: 8 }, (_, i) => ({
  id: `scroll-${i}`,
  name: `Scroll ${i}`,
  command: '/usr/bin/env bash',
  lazy: true,
}));

test.describe('Terminal dashboard scroll restore (HS-9627)', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/projects');
    const projects = (await res.json()) as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page, request }) => {
    // Tauri stub — mirror the desktop session the dashboard was built for.
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__TAURI__ = {
        core: { invoke: () => Promise.resolve(undefined) },
      };
    });

    // Clean any dynamic terminals from earlier tests, then configure our eight.
    try {
      const list = (await (await request.get('/api/terminal/list', { headers })).json()) as {
        dynamic?: { id: string }[];
      };
      for (const d of list.dynamic ?? []) {
        await request.post('/api/terminal/destroy', { headers, data: { terminalId: d.id } });
      }
    } catch {
      /* fine on first run */
    }

    await request.patch('/api/file-settings', {
      headers,
      data: { terminal_enabled: 'true', drawer_open: 'false', terminals: TERMINALS },
    });
  });

  test('remembers scroll position across a switch-away and switch-back', async ({ page }) => {
    // Short viewport so the 1-column stack is guaranteed to overflow.
    await page.setViewportSize({ width: 900, height: 520 });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const root = page.locator('#terminal-dashboard-root');

    // Enter the dashboard and force the largest tiles (slider max = biggest
    // tiles = fewest columns = tallest stack), so eight tiles overflow the
    // short viewport with plenty of headroom.
    await page.locator('#terminal-dashboard-toggle').click();
    await expect(root).toBeVisible();
    const slider = page.locator('#terminal-dashboard-size-slider');
    await slider.evaluate((el: HTMLInputElement) => {
      el.value = '10';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Wait until the grid actually overflows the container, else the test is
    // meaningless (nothing to scroll).
    await expect
      .poll(async () => root.evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 10000 })
      .toBeGreaterThan(200);

    // Scroll down a meaningful amount.
    const target = 240;
    await root.evaluate((el, top) => {
      el.scrollTop = top;
    }, target);
    const before = await root.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(200);

    // Switch away (toggle back to the ticket view), then switch back.
    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(0);
    await page.locator('#terminal-dashboard-toggle').click();
    await expect(root).toBeVisible();

    // The grid must overflow again before the restore can land.
    await expect
      .poll(async () => root.evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 10000 })
      .toBeGreaterThan(200);

    // Best-effort restore: we should be back near `before`, and crucially NOT
    // reset to the top (the pre-fix behavior).
    await expect
      .poll(async () => root.evaluate((el) => el.scrollTop), { timeout: 5000 })
      .toBeGreaterThan(150);
    const after = await root.evaluate((el) => el.scrollTop);
    expect(Math.abs(after - before)).toBeLessThan(60);
  });
});
