/**
 * HS-8015 follow-up #2 — verifies the running-shell Commands Log entry
 * shows live partial output as it arrives AND lets the user click the
 * row to expand into a full-output view, all while the underlying shell
 * is still running. Pre-fix the row's preview pre carried a CSS-conflict
 * with `.command-log-detail` that pinned the live preview to the FIRST 3
 * lines with no scroll, AND the click handler skipped expansion when
 * `hasMore` was false (which it was for a running-shell with a short
 * command line). The user reported "i still dont see data coming in as
 * it's ready" and asked for an e2e test with screenshots — both
 * captured here.
 */
import { expect, test } from './coverage-fixture.js';

let headers: Record<string, string> = {};

test.describe('Live shell-command streaming in Commands Log (HS-8015 follow-up #2)', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/projects');
    const projects = await res.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page }) => {
    // Suppress the §50 upgrade-nudge overlay (writes a Number.MAX_SAFE_INTEGER
    // sentinel into the same localStorage key the "Don't show again" link
    // uses) so the modal doesn't intercept drawer clicks. Without this the
    // nudge fires on first load in npm-mode (Tauri stub absent) and the
    // backdrop blocks everything.
    await page.addInitScript(() => {
      localStorage.setItem('hotsheet_upgrade_nudge_last_shown', String(Number.MAX_SAFE_INTEGER));
    });
  });

  /** Open Hot Sheet, suppress nudges, open the Commands Log drawer.
   *  Idempotent — the drawer's open/closed state is persisted via
   *  `drawer_open` in the project's settings, so a previous test that
   *  opened the drawer leaves it open across the page reload. We only
   *  click the toggle if it isn't already open. */
  async function openCommandsLogDrawer(page: import('@playwright/test').Page): Promise<void> {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    // Allow `applyPerProjectDrawerState` to settle so the toggle click
    // doesn't race the on-init drawer-state restoration.
    await page.waitForTimeout(800);
    const panelVisible = await page.locator('#command-log-panel').evaluate((el: HTMLElement) => {
      return el.style.display !== 'none' && el.getBoundingClientRect().height > 50;
    }).catch(() => false);
    if (!panelVisible) {
      await page.locator('#command-log-btn').click();
    }
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 5000 });
    await page.waitForFunction(() => {
      const el = document.getElementById('command-log-panel');
      return el !== null && el.getBoundingClientRect().height > 50;
    }, undefined, { timeout: 5000 });
    // Force the commands-log tab active so a fresh `loadEntries()` fires
    // immediately. Pre-check whether the tab is already active so we
    // don't bounce off a no-op switch.
    const isActive = await page.locator('#drawer-tab-commands-log').evaluate(
      (el: HTMLElement) => el.classList.contains('active'),
    ).catch(() => false);
    if (!isActive) {
      await page.locator('#drawer-tab-commands-log').click();
    }
  }

  test('live preview fills + row expands while command is still running', async ({ page, request }, testInfo) => {
    await openCommandsLogDrawer(page);

    // Kick off a slow streaming command — 12 emit-and-sleep iterations
    // at 0.6 s each = ~7 s. The Commands Log polls every 5 s, so the
    // entry will be re-rendered at least once mid-stream and we can
    // observe the live writer keeping the partial pres in sync.
    const execRes = await request.post('/api/shell/exec', {
      headers,
      data: { command: 'for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo "stream-line-$i"; sleep 0.6; done' },
    });
    expect(execRes.ok()).toBe(true);
    const { id } = await execRes.json() as { id: number };
    expect(id).toBeGreaterThan(0);

    // Wait for the running-shell entry to render. The Commands Log
    // polls every 5 s — give it up to 10 s to accommodate timing drift.
    const entry = page.locator(`.command-log-entry[data-id="${id}"]`);
    await expect(entry).toBeVisible({ timeout: 10000 });

    // Wait until the preview pre has actual streamed content.
    const previewPre = entry.locator('pre[data-shell-partial-id][data-shell-partial-mode="preview"]');
    const fullPre = entry.locator('pre[data-shell-partial-id][data-shell-partial-mode="full"]');
    await expect(previewPre).toContainText(/stream-line-\d+/, { timeout: 8000 });

    // SCREENSHOT 1 — collapsed row, mid-stream.
    const collapsedShot = await entry.screenshot({ path: 'test-results/hs-8015-followup-collapsed.png' });
    await testInfo.attach('hs-8015-followup-collapsed.png', { body: collapsedShot, contentType: 'image/png' });

    // The running-shell row must NOT be marked as expanded yet.
    await expect(entry).not.toHaveClass(/expanded/);

    // The full pre is still in the DOM (so the live writer fills it
    // alongside the preview) but is hidden via inline style.
    await expect(fullPre).toHaveCount(1);
    expect(await fullPre.evaluate((el: HTMLElement) => el.style.display)).toBe('none');

    // CLICK the row — pre-fix this did nothing for a running-shell
    // because `hasMore` was false. Post-fix `isRunningShell` makes the
    // row expandable.
    await entry.click();
    await expect(entry).toHaveClass(/expanded/, { timeout: 2000 });

    // Now the preview is hidden and the full pre is visible.
    await expect(previewPre).toBeHidden();
    await expect(fullPre).toBeVisible();
    await expect(fullPre).toContainText(/stream-line-1\b/);

    // SCREENSHOT 2 — expanded row, mid-stream.
    const expandedShot = await entry.screenshot({ path: 'test-results/hs-8015-followup-expanded.png' });
    await testInfo.attach('hs-8015-followup-expanded.png', { body: expandedShot, contentType: 'image/png' });

    // Wait for the buffer to keep growing while expanded — the live
    // writer must continue feeding the full pre across re-renders.
    await expect(fullPre).toContainText(/stream-line-5\b/, { timeout: 10000 });

    // Wait for the command to finish and the row to transition to the
    // completed-shell branch (the `data-shell-partial-mode` pres go away).
    await expect(fullPre).toHaveCount(0, { timeout: 20000 });

    // Entry remains visible and the expanded state survives the post-
    // completion re-render.
    await expect(entry).toBeVisible();
    await expect(entry).toHaveClass(/expanded/);
    await expect(entry.locator('.command-log-detail-full')).toContainText(/stream-line-12\b/);

    // SCREENSHOT 3 — completed entry, expanded.
    const completedShot = await entry.screenshot({ path: 'test-results/hs-8015-followup-completed.png' });
    await testInfo.attach('hs-8015-followup-completed.png', { body: completedShot, contentType: 'image/png' });
  });

  test('preview pre tails the trailing 3 lines (not the first 3)', async ({ page, request }, testInfo) => {
    await openCommandsLogDrawer(page);

    // 10 lines at 0.6 s each = 6 s. By the time the first poll renders
    // the entry, the buffer has multiple lines. The preview must show
    // the LAST 3, not the first 3 — this is the visual half of the bug.
    const execRes = await request.post('/api/shell/exec', {
      headers,
      data: { command: 'for i in 1 2 3 4 5 6 7 8 9 10; do echo "tail-line-$i"; sleep 0.6; done' },
    });
    const { id } = await execRes.json() as { id: number };
    const entry = page.locator(`.command-log-entry[data-id="${id}"]`);
    await expect(entry).toBeVisible({ timeout: 10000 });
    const previewPre = entry.locator('pre[data-shell-partial-mode="preview"]');

    // Wait for the buffer to grow past line 6 so the trailing-3 helper
    // has reason to drop the early lines.
    await expect(previewPre).toContainText(/tail-line-[6789]/, { timeout: 12000 });

    const previewText = (await previewPre.textContent()) ?? '';
    // The preview must NOT contain the very first lines anymore.
    expect(previewText).not.toContain('tail-line-1');
    expect(previewText).not.toContain('tail-line-2');
    // It MUST contain at least one of the recent lines.
    expect(previewText).toMatch(/tail-line-[6-9]/);

    const tailShot = await entry.screenshot({ path: 'test-results/hs-8015-followup-tail.png' });
    await testInfo.attach('hs-8015-followup-tail.png', { body: tailShot, contentType: 'image/png' });

    // Clean up — wait for completion so the shell process doesn't bleed
    // into the next test's running-shell ids.
    await expect(entry.locator('pre[data-shell-partial-mode="full"]')).toHaveCount(0, { timeout: 20000 });
  });
});
