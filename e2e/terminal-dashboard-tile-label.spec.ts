/**
 * HS-9000 — the dashboard tile's project/terminal name must ALWAYS be visible
 * (left-aligned), never collapsed to zero width by the right-aligned stats
 * cluster (open/up-next counts + busy spinner). Uses stubbed `not_spawned`
 * terminals so no real PTY is started.
 */
import { expect, test } from './coverage-fixture.js';

let headers: Record<string, string> = {};

test.describe('Terminal dashboard tile label always shows (HS-9000)', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/projects');
    const projects = await res.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test('tile name renders with non-zero width on narrow tiles (counts cluster present)', async ({ page, request }) => {
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__TAURI__ = { core: { invoke: async () => undefined } };
    });
    // Narrow tiles (many columns) so the stats cluster could crowd the name.
    await request.patch('/api/global-config', { headers, data: { dashboard: { layoutMode: 'flow', columnsPerRow: 5 } } });
    await page.route('**/api/terminal/list*', async route => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          home: '/home/user',
          configured: [
            { id: 'a', name: 'Alpha terminal name', command: 'echo a', lazy: true, bellPending: false, state: 'not_spawned' },
            { id: 'b', name: 'Beta terminal name', command: 'echo b', lazy: true, bellPending: false, state: 'not_spawned' },
          ],
          dynamic: [],
        }),
      });
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();

    const names = page.locator('.terminal-dashboard-tile-name');
    await expect(names.first()).toBeVisible({ timeout: 5000 });

    // The regression: HS-9056's `container-type: inline-size` collapsed the label
    // to ZERO width (the name then overflowed + the container query always read
    // 0 < threshold). Assert each label has a real width (≈ the tile width) AND
    // the name renders within it with a non-zero width.
    const measured = await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('.terminal-dashboard-tile-label'));
      return labels.map(l => ({
        labelW: Math.round((l as HTMLElement).getBoundingClientRect().width),
        nameText: l.querySelector('.terminal-dashboard-tile-name')?.textContent ?? '',
        nameW: Math.round((l.querySelector('.terminal-dashboard-tile-name') as HTMLElement | null)?.getBoundingClientRect().width ?? 0),
      }));
    });
    expect(measured.length).toBeGreaterThan(0);
    for (const m of measured) {
      expect(m.labelW, `tile label must not be collapsed (got ${m.labelW}px for "${m.nameText}")`).toBeGreaterThan(50);
      expect(m.nameW, `tile name "${m.nameText}" must be visible`).toBeGreaterThan(0);
    }
  });
});
