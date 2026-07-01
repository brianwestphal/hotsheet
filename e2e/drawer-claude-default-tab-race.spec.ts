/**
 * HS-9246 (regression) — the initially-selected project failed to default to
 * the Claude tab on relaunch. Root cause: a drawer mutation (a PROGRAMMATIC
 * `openPanel`/`closePanel` from a boot-time channel / command-completion /
 * terminal-spawn event) landing during the boot `applyPerProjectDrawerState`
 * fetch bumped the HS-8443 epoch, and the pre-fix hard bail abandoned the WHOLE
 * restore — dropping the first-open Claude default. The initially-selected
 * project loses because its boot races the most concurrent startup activity;
 * later-clicked projects run their restore after the app has settled.
 *
 * We widen the fetch window by delaying `/api/file-settings` and open the drawer
 * during it (mirrors the stray boot-time open). The Claude default must survive.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Drawer Claude default tab — mid-fetch open race (HS-9246)', () => {
  test('a drawer open during the boot fetch must not drop the Claude default', async ({ page, request }) => {
    const projects = await (await request.get('/api/projects')).json() as { secret: string }[];
    const aSecret = projects[0]?.secret ?? '';
    expect(aSecret).not.toBe('');

    // Saved tab is the shell, drawer saved OPEN. First open since launch must
    // still surface Claude even though a mutation lands mid-fetch.
    await request.patch('/api/file-settings', {
      headers: { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': aSecret },
      data: {
        drawer_open: 'true',
        drawer_active_tab: 'terminal:shell',
        terminals: [
          { id: 'shell', name: 'Shell', command: '/bin/echo shell', lazy: true },
          { id: 'claude', name: 'Claude', command: '{{claudeCommand}}', lazy: true },
        ],
      },
    });

    // Hold the boot restore open on the file-settings GET so a concurrent drawer
    // mutation lands inside its window.
    await page.route('**/api/file-settings**', async (route) => {
      if (route.request().method() === 'GET') await new Promise((r) => setTimeout(r, 800));
      await route.continue();
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    // Open the drawer while the boot restore is suspended on the delayed fetch —
    // a single programmatic-style open (bumps the HS-8443 open/close epoch, not
    // the user-tab-switch epoch).
    await page.locator('#command-log-btn').click().catch(() => undefined);

    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 3000 });
    // The Claude default must still win despite the mid-fetch open.
    await expect(page.locator('.drawer-tab[data-drawer-tab="terminal:claude"]'))
      .toHaveClass(/active/, { timeout: 3000 });
    await expect(page.locator('.drawer-tab[data-drawer-tab="terminal:shell"]'))
      .not.toHaveClass(/active/);
  });
});
