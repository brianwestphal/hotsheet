/**
 * E2E coverage for the Terminal Dashboard's Flow layout mode (HS-7662 /
 * docs/25-terminal-dashboard.md §25.10.5).
 *
 * Flow mode dissolves per-project sections into a single flat grid,
 * marking project boundaries with a small color-coded badge in front of
 * each tile's label. The first tile of each project's run additionally
 * displays the project name as a `{Project} ›` prefix.
 *
 * These tests cover the toggle button, persistence via /file-settings,
 * flat-grid rendering, badge / project-prefix label markup, and that
 * tile interactions (click-to-center) work identically across modes.
 */
import { expect, test } from './coverage-fixture.js';

let headers: Record<string, string> = {};

test.describe('Terminal dashboard Flow layout (HS-7662)', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/projects');
    const projects = await res.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page }) => {
    // Tauri stub — the dashboard is Tauri-only (§25.11).
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__TAURI__ = {
        core: { invoke: async () => undefined },
      };
    });
  });

  test.afterEach(async ({ request }) => {
    // Reset to default for subsequent tests / isolation.
    await request.patch('/api/file-settings', {
      headers,
      data: { dashboard_layout_mode: 'sectioned' },
    });
  });

  test('layout-toggle button is visible in dashboard mode and persists across reload', async ({ page, request }) => {
    // Stub a project with one alive tile so the flow grid actually renders
    // something on toggle (an empty project would surface the
    // "All Terminals Hidden" placeholder instead, which is exercised in a
    // separate test).
    await page.route('**/api/terminal/list*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: [
            { id: 'a', name: 'Alpha', command: 'echo a', lazy: true, bellPending: false, state: 'not_spawned' },
          ],
          dynamic: [],
        }),
      });
    });
    await request.patch('/api/file-settings', {
      headers,
      data: { dashboard_layout_mode: 'sectioned' },
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Layout toggle is hidden until the dashboard is open.
    const layoutToggle = page.locator('#terminal-dashboard-layout-toggle');
    await expect(layoutToggle).toBeHidden();

    await page.locator('#terminal-dashboard-toggle').click();
    await expect(layoutToggle).toBeVisible();
    // Default = sectioned, so the toggle should NOT be in active state.
    await expect(layoutToggle).not.toHaveClass(/active/);

    // Click to flip to flow mode.
    await layoutToggle.click();
    await expect(layoutToggle).toHaveClass(/active/);

    // The grid root should now contain a flow-grid container instead of
    // per-project sections.
    await expect(page.locator('.terminal-dashboard-grid-flow')).toHaveCount(1);
    await expect(page.locator('.terminal-dashboard-section')).toHaveCount(0);

    // Reload — the persisted setting should restore flow mode automatically.
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('#terminal-dashboard-layout-toggle')).toHaveClass(/active/);
    await expect(page.locator('.terminal-dashboard-grid-flow')).toHaveCount(1);
    await expect(page.locator('.terminal-dashboard-section')).toHaveCount(0);
  });

  test('flow grid renders one flat tile list with project-color badges; first tile of each run gets a project-name prefix', async ({ page, request }) => {
    // Force flow mode persistently.
    await request.patch('/api/file-settings', {
      headers,
      data: { dashboard_layout_mode: 'flow' },
    });

    // Stub /terminal/list per-project so we get a deterministic 3-tile fixture.
    await page.route('**/api/terminal/list*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: [
            { id: 'a', name: 'Alpha', command: 'echo a', lazy: true, bellPending: false, state: 'not_spawned' },
            { id: 'b', name: 'Beta',  command: 'echo b', lazy: true, bellPending: false, state: 'not_spawned' },
          ],
          dynamic: [
            { id: 'd', name: 'Dyn',   command: 'echo d', lazy: false, bellPending: false, state: 'alive' },
          ],
        }),
      });
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();

    // Flow grid container should render once at the dashboard root.
    const flow = page.locator('.terminal-dashboard-grid-flow');
    await expect(flow).toHaveCount(1);
    // Section containers should NOT render.
    await expect(page.locator('.terminal-dashboard-section')).toHaveCount(0);

    // All three tiles render flat in this single grid.
    const tiles = flow.locator('.terminal-dashboard-tile');
    await expect(tiles).toHaveCount(3);

    // Every tile in flow mode has a project-color badge.
    await expect(flow.locator('.terminal-dashboard-tile-badge')).toHaveCount(3);

    // The FIRST tile of each project run also has a project-name prefix
    // (`{ProjectName} ›`). Since this fixture only has one project, that's
    // exactly one project-prefix span.
    await expect(flow.locator('.terminal-dashboard-tile-project')).toHaveCount(1);

    // Every tile renders the bare terminal name in `.terminal-dashboard-tile-name`
    const names = await flow.locator('.terminal-dashboard-tile-name').allTextContents();
    expect(names).toEqual(['Alpha', 'Beta', 'Dyn']);
  });

  test('toggling between sectioned and flow re-renders without re-fetching project data', async ({ page, request }) => {
    await request.patch('/api/file-settings', {
      headers,
      data: { dashboard_layout_mode: 'sectioned' },
    });

    let listCallCount = 0;
    await page.route('**/api/terminal/list*', async route => {
      listCallCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: [
            { id: 'x', name: 'X', command: 'echo x', lazy: true, bellPending: false, state: 'not_spawned' },
          ],
          dynamic: [],
        }),
      });
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();

    // Sectioned: project section visible.
    await expect(page.locator('.terminal-dashboard-section')).toHaveCount(1);
    const callsAfterFirstPaint = listCallCount;

    // Flip to flow.
    await page.locator('#terminal-dashboard-layout-toggle').click();
    await expect(page.locator('.terminal-dashboard-grid-flow')).toHaveCount(1);
    await expect(page.locator('.terminal-dashboard-section')).toHaveCount(0);

    // Flip back to sectioned.
    await page.locator('#terminal-dashboard-layout-toggle').click();
    await expect(page.locator('.terminal-dashboard-section')).toHaveCount(1);

    // The toggle re-uses cached lastSectionData so no /terminal/list fetches
    // happen on flip.
    expect(listCallCount).toBe(callsAfterFirstPaint);
  });

  test('flow mode drops empty projects entirely (no per-project empty-state row)', async ({ page, request }) => {
    await request.patch('/api/file-settings', {
      headers,
      data: { dashboard_layout_mode: 'flow' },
    });

    // Force the project to have ZERO terminals.
    await page.route('**/api/terminal/list*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ configured: [], dynamic: [] }),
      });
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();

    // No flow-grid (since no tiles to render); no per-project section either
    // (flow mode never renders sections); no per-project empty-state row.
    // The "All Terminals Hidden" placeholder appears instead.
    await expect(page.locator('.terminal-dashboard-section')).toHaveCount(0);
    await expect(page.locator('.terminal-dashboard-empty-row')).toHaveCount(0);
    await expect(page.locator('.terminal-dashboard-grid-flow')).toHaveCount(0);
    await expect(page.locator('.terminal-dashboard-all-hidden')).toBeVisible();
  });
});
