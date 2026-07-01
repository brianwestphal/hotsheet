/**
 * HS-9246 — the bottom drawer defaults to the Claude terminal tab on a project's
 * first open since app launch (and on a brand-new project), but ONLY when the
 * project actually has a Claude terminal (a terminal whose command is the
 * `{{claudeCommand}}` sentinel). Otherwise the saved tab is restored.
 *
 * The pure decision matrix is unit-tested in `src/client/drawerActiveTab.test.ts`;
 * this spec proves the full DOM wiring — config → detection → active tab.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Drawer defaults to the Claude tab (HS-9246)', () => {
  async function secretFor(request: import('@playwright/test').APIRequestContext): Promise<string> {
    const projects = await (await request.get('/api/projects')).json() as { secret: string }[];
    return projects[0]?.secret ?? '';
  }

  test('first open since launch selects the Claude tab, overriding the saved tab', async ({ page, request }) => {
    const secret = await secretFor(request);
    const headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret };
    // A plain shell + a Claude terminal, with the shell PRE-SELECTED as the saved
    // tab. First open since launch must still surface Claude over the saved shell.
    await request.patch('/api/file-settings', {
      headers,
      data: {
        drawer_open: 'true',
        drawer_active_tab: 'terminal:shell',
        terminals: [
          { id: 'shell', name: 'Shell', command: '/bin/echo shell', lazy: true },
          { id: 'claude', name: 'Claude', command: '{{claudeCommand}}', lazy: true },
        ],
      },
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 3000 });

    await expect(page.locator('.drawer-tab[data-drawer-tab="terminal:claude"]'))
      .toHaveClass(/active/, { timeout: 3000 });
    await expect(page.locator('.drawer-tab[data-drawer-tab="terminal:shell"]'))
      .not.toHaveClass(/active/);
  });

  test('no Claude terminal → the saved tab is honored (default behavior unchanged)', async ({ page, request }) => {
    const secret = await secretFor(request);
    const headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret };
    // Only plain shells, saved tab = commands-log. Without a Claude terminal the
    // first-open default must not kick in.
    await request.patch('/api/file-settings', {
      headers,
      data: {
        drawer_open: 'true',
        drawer_active_tab: 'commands-log',
        terminals: [
          { id: 'shell', name: 'Shell', command: '/bin/echo shell', lazy: true },
        ],
      },
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 3000 });

    await expect(page.locator('#drawer-tab-commands-log')).toHaveClass(/active/, { timeout: 3000 });
    await expect(page.locator('.drawer-tab[data-drawer-tab="terminal:shell"]'))
      .not.toHaveClass(/active/);
  });
});
