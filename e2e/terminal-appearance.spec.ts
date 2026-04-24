/**
 * HS-6307 — Playwright e2e for the terminal appearance gear popover
 * (docs/35-terminal-themes.md §35.5).
 *
 * Covers the dynamic-terminal path: open the drawer, click the gear button,
 * pick Dracula from the theme dropdown, and assert that xterm's `ITheme`
 * background colour (exposed via `term.options.theme.background` on the live
 * instance) becomes `#282a36`. The second test asserts Reset-to-default
 * clears the session override so the appearance falls back to the default
 * theme — the gear popover is the single entry point, so a round-trip here
 * covers both the set + reset flows.
 *
 * Runs against a lazy echo fixture so the PTY is cheap; the appearance
 * switch is xterm-only (no PTY touch), so we don't need a fancy fixture.
 */
import { expect, test } from './coverage-fixture.js';

let headers: Record<string, string> = {};

test.describe('Terminal appearance gear popover (HS-6307)', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/projects');
    const projects = await res.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page, request }) => {
    // Tauri stub — the embedded terminal is Tauri-only gated.
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__TAURI__ = {
        core: { invoke: async () => undefined },
      };
    });

    // Clear dynamic terminals so the per-test PTY state is deterministic.
    try {
      const list = await (await request.get('/api/terminal/list', { headers })).json() as {
        dynamic?: { id: string }[];
      };
      for (const d of list.dynamic ?? []) {
        await request.post('/api/terminal/destroy', { headers, data: { terminalId: d.id } });
      }
    } catch { /* first run */ }

    // Reset the project-default appearance to empty so the fallback applies
    // (theme: default). Ensures the test starts from a known baseline.
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'false',
        drawer_active_tab: 'commands-log',
        terminal_default: {},
        // A cheap always-open terminal the test can attach to.
        terminals: [
          { id: 'appearance-terminal', name: 'Appearance', command: '/bin/sh -c "while :; do :; done"', lazy: false },
        ],
      },
    });

    // Restart the PTY so a fresh one runs the command above (earlier runs
    // may have left it at a different command).
    try {
      await request.post('/api/terminal/restart', { headers, data: { terminalId: 'appearance-terminal' } });
    } catch { /* not yet spawned */ }
  });

  async function openDrawerAndActivateTerminal(page: import('@playwright/test').Page): Promise<void> {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#command-log-btn').click();
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 5000 });
    const tab = page.locator('.drawer-terminal-tab[data-terminal-id="appearance-terminal"]');
    await expect(tab).toBeVisible({ timeout: 5000 });
    await tab.click();
    const pane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:appearance-terminal"]');
    await expect(pane).toBeVisible({ timeout: 5000 });
    // Wait for xterm to mount + apply appearance so `term.options.theme`
    // is populated. A viewport query is the cheapest mount signal.
    await expect(pane.locator('.xterm-viewport')).toBeVisible({ timeout: 8000 });
  }

  /** Read `term.options.theme.background` off the live xterm instance by
   *  round-tripping through the xterm-screen's computed style. The
   *  `.xterm` root element's `backgroundColor` CSS property reflects the
   *  active theme background on every render. */
  async function readBackgroundColor(page: import('@playwright/test').Page): Promise<string> {
    return page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(
        '.drawer-terminal-pane[data-drawer-panel="terminal:appearance-terminal"] .xterm',
      );
      if (el === null) return '';
      return window.getComputedStyle(el).backgroundColor;
    });
  }

  test('gear popover: switch to Dracula applies the theme background live', async ({ page }) => {
    await openDrawerAndActivateTerminal(page);

    const pane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:appearance-terminal"]');
    const gearBtn = pane.locator('.terminal-appearance-btn');
    await expect(gearBtn).toBeVisible();
    await gearBtn.click();

    // Popover opens on body (position: fixed), not inside the pane.
    const popover = page.locator('.terminal-appearance-popover');
    await expect(popover).toBeVisible({ timeout: 3000 });

    const themeSelect = popover.locator('.terminal-appearance-theme');
    await expect(themeSelect).toBeVisible();
    // The theme list must include every shipped theme; pick Dracula.
    await themeSelect.selectOption('dracula');

    // The appearance applier awaits loadGoogleFont (a no-op for System) and
    // then assigns `term.options.theme`. xterm updates the canvas background
    // on the next render — poll the computed background-color until it lands
    // on Dracula's #282a36 = rgb(40, 42, 54).
    await expect.poll(() => readBackgroundColor(page), { timeout: 3000 })
      .toMatch(/rgb\(\s*40\s*,\s*42\s*,\s*54\s*\)/);
  });

  test('gear popover: Reset to project default reverts the session override', async ({ page }) => {
    await openDrawerAndActivateTerminal(page);

    const pane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:appearance-terminal"]');
    const gearBtn = pane.locator('.terminal-appearance-btn');

    // Step 1: switch to One Dark so the session override is non-empty.
    await gearBtn.click();
    const popover = page.locator('.terminal-appearance-popover');
    await expect(popover).toBeVisible({ timeout: 3000 });
    const themeSelect = popover.locator('.terminal-appearance-theme');
    await themeSelect.selectOption('one-dark');

    // One Dark's background is #282c34 = rgb(40, 44, 52). Wait for it to
    // actually land on the canvas before clicking Reset.
    await expect.poll(() => readBackgroundColor(page), { timeout: 3000 })
      .toMatch(/rgb\(\s*40\s*,\s*44\s*,\s*52\s*\)/);

    // Step 2: click "Reset to project default" — the project default is
    // empty (beforeEach sets terminal_default: {}), so the appearance falls
    // back to the Default theme (CSS-var-derived — white background in the
    // test env because no dark mode is set).
    const resetBtn = popover.locator('.terminal-appearance-reset');
    await resetBtn.click();

    // Close the popover so it doesn't hold focus.
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0, { timeout: 2000 });

    // Background should revert away from One Dark's #282c34.
    await expect.poll(() => readBackgroundColor(page), { timeout: 3000 })
      .not.toMatch(/rgb\(\s*40\s*,\s*44\s*,\s*52\s*\)/);
  });
});
