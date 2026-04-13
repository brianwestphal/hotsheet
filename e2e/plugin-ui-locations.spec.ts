/**
 * HS-5066: plugin UI extension locations all render correctly.
 *
 * Creates a temporary fixture plugin that registers a button at every
 * PluginUILocation, installs it via the bundled install flow, and then
 * verifies each button appears in the correct DOM container.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { expect, test } from './coverage-fixture.js';

const PLUGINS_ENABLED = process.env.PLUGINS_ENABLED === 'true';

// The fixture plugin entry point: registers a button at every UI location.
const FIXTURE_INDEX_JS = `
export async function activate(context) {
  context.registerUI([
    { id: 'fixture-toolbar', type: 'button', location: 'toolbar', label: 'FT', action: 'test-toolbar', title: 'Fixture Toolbar' },
    { id: 'fixture-status-bar', type: 'button', location: 'status_bar', label: 'FSB', action: 'test-status-bar', title: 'Fixture Status Bar' },
    { id: 'fixture-detail-top', type: 'button', location: 'detail_top', label: 'FDT', action: 'test-detail-top', title: 'Fixture Detail Top' },
    { id: 'fixture-detail-bottom', type: 'button', location: 'detail_bottom', label: 'FDB', action: 'test-detail-bottom', title: 'Fixture Detail Bottom' },
    { id: 'fixture-context-menu', type: 'button', location: 'context_menu', label: 'Context Fixture', action: 'test-context', title: 'Fixture Context' },
  ]);
}
`;

const FIXTURE_MANIFEST = JSON.stringify({
  id: 'test-fixture',
  name: 'Test Fixture Plugin',
  version: '1.0.0',
  description: 'E2E test fixture — registers UI elements at every location',
});

test.describe('Plugin UI extension locations (HS-5066)', () => {
  test.skip(!PLUGINS_ENABLED, 'PLUGINS_ENABLED not set');
  test.setTimeout(60_000);

  let headers: Record<string, string> = {};
  const fixtureDir = join(process.cwd(), 'dist', 'plugins', 'test-fixture');

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    const secret = projects[0]?.secret ?? '';
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret };

    // Create the fixture plugin in dist/plugins/ so the bundled install can find it
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, 'manifest.json'), FIXTURE_MANIFEST);
    writeFileSync(join(fixtureDir, 'index.js'), FIXTURE_INDEX_JS);

    // Install via bundled install (this calls loadAllPlugins which loads the fixture)
    const installRes = await request.post('/api/plugins/bundled/test-fixture/install', { headers });
    expect(installRes.ok()).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    // Uninstall the fixture plugin
    try {
      await request.post('/api/plugins/test-fixture/uninstall', { headers });
    } catch { /* ignore */ }
    // Remove from dist/plugins/ so it doesn't persist
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('fixture plugin is loaded and returns UI elements via API', async ({ request }) => {
    const uiRes = await request.get('/api/plugins/ui', { headers });
    const elements = await uiRes.json() as { id: string; location: string; _pluginId: string }[];

    const fixtureElements = elements.filter(e => e._pluginId === 'test-fixture');
    expect(fixtureElements.length).toBeGreaterThanOrEqual(5);

    // Verify each location is represented
    const locations = new Set(fixtureElements.map(e => e.location));
    expect(locations.has('toolbar')).toBe(true);
    expect(locations.has('status_bar')).toBe(true);
    expect(locations.has('detail_top')).toBe(true);
    expect(locations.has('detail_bottom')).toBe(true);
    expect(locations.has('context_menu')).toBe(true);
  });

  test('toolbar button renders in the header toolbar', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // The fixture toolbar button should appear in the plugin toolbar container
    const toolbarBtn = page.locator('.plugin-toolbar-container .plugin-toolbar-btn[title="Fixture Toolbar"]');
    await expect(toolbarBtn).toBeVisible({ timeout: 10000 });
  });

  test('detail_top and detail_bottom buttons render in the detail panel', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Create a ticket and wait for it to appear in the list
    const draftInput = page.locator('.draft-input');
    await draftInput.fill('UI location test ticket');
    await draftInput.press('Enter');
    const ticketRow = page.locator('.ticket-row[data-id]').first();
    await expect(ticketRow).toBeVisible({ timeout: 5000 });
    await ticketRow.locator('.ticket-number').click();
    await expect(page.locator('#detail-header')).toBeVisible({ timeout: 5000 });

    // detail_top button should render above the fields
    const detailTop = page.locator('#plugin-detail-top [title="Fixture Detail Top"]');
    await expect(detailTop).toBeVisible({ timeout: 5000 });

    // detail_bottom button should render below meta
    const detailBottom = page.locator('#plugin-detail-bottom [title="Fixture Detail Bottom"]');
    await expect(detailBottom).toBeVisible({ timeout: 5000 });
  });

  test('context_menu button renders in the right-click menu', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Create a ticket and wait for it to appear
    const draftInput = page.locator('.draft-input');
    await draftInput.fill('Context menu test ticket');
    await draftInput.press('Enter');
    const ticketRow = page.locator('.ticket-row[data-id]').first();
    await expect(ticketRow).toBeVisible({ timeout: 5000 });

    // Right-click the ticket row
    await ticketRow.click({ button: 'right' });

    // The context menu should contain the fixture button
    const contextMenu = page.locator('.context-menu');
    await expect(contextMenu).toBeVisible({ timeout: 3000 });
    const fixtureItem = contextMenu.locator('.context-menu-item', { hasText: 'Context Fixture' });
    await expect(fixtureItem).toBeVisible();
  });
});
