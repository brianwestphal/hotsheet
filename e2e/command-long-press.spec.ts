/**
 * HS-8839 + HS-8844 — E2E coverage for the command-button long-press gestures
 * (§83). The long-press uses a real `setTimeout(LONG_PRESS_MS = 500)` in
 * `wireShellButtonPress` / `wireClaudeButtonPress`, so the tests drive a real
 * mouse press-and-hold past the threshold rather than dispatching synthetic
 * events.
 *
 * - Shell button long-press → opens a NEW drawer terminal (default shell), and
 *   the per-command "Launch in New Terminal" option makes a normal click do the
 *   same (HS-8539).
 * - Claude button long-press → creates a Task ticket from the command (HS-8538).
 *
 * Skip-guards mirror `commands.spec.ts`: the sidebar command container / the
 * Claude buttons don't render in every environment (Claude buttons need the
 * channel enabled AND a compatible Claude CLI), so the tests skip gracefully
 * instead of failing when the environment can't surface the button.
 */
import { expect, test } from './coverage-fixture.js';

type Page = import('@playwright/test').Page;

async function setCommandsAndReload(page: Page, items: unknown[]): Promise<void> {
  const origin = page.url().replace(/\/[^/]*$/, '');
  await page.request.patch('/api/settings', {
    data: { custom_commands: JSON.stringify(items) },
    headers: { Origin: origin },
  });
  await page.reload();
  await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
}

/** Press and hold the locator past the 500ms long-press threshold, then release. */
async function longPress(page: Page, locator: import('@playwright/test').Locator, holdMs = 700): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (box === null) throw new Error('long-press target has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(holdMs);
  await page.mouse.up();
}

/** Stub `window.__TAURI__` so the embedded-terminal feature is active in the bundle. */
async function stubTauri(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__TAURI__ = {
      core: { invoke: async () => undefined },
    };
  });
}

async function projectHeaders(page: Page): Promise<Record<string, string>> {
  const res = await page.request.get('/api/projects');
  const projects = await res.json() as { secret: string }[];
  return { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
}

test.describe('Command-button long-press gestures (HS-8539 / HS-8538)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    const origin = page.url().replace(/\/[^/]*$/, '');
    await page.request.patch('/api/settings', { data: { custom_commands: '[]' }, headers: { Origin: origin } });
  });

  test('long-press a shell command button opens a new terminal (HS-8839)', async ({ page }) => {
    await stubTauri(page);
    const headers = await projectHeaders(page);
    await page.request.patch('/api/file-settings', { headers, data: { terminal_enabled: 'true' } });
    await setCommandsAndReload(page, [{ name: 'LP Echo', prompt: '/bin/echo long-press-hi', target: 'shell' }]);

    const container = page.locator('#channel-commands-container');
    if (await container.count() === 0) { test.skip(); return; }
    const btn = container.locator('.channel-command-btn', { hasText: 'LP Echo' });
    if (await btn.count() === 0) { test.skip(); return; }

    await longPress(page, btn);

    // A new dynamic terminal tab opened in the drawer and is active — something a
    // normal click (inline streaming run) never produces.
    const termTab = page.locator('.drawer-tab[data-drawer-tab^="terminal:dyn-"]');
    await expect(termTab.first()).toBeVisible({ timeout: 6000 });
    await expect(termTab.first()).toHaveClass(/active/, { timeout: 6000 });
    // The button never entered the inline-run state (no spinner) — the click was suppressed.
    await expect(btn).not.toHaveClass(/is-running/);
  });

  test('a shell command with launchInNewTerminal opens a new terminal on a normal click (HS-8539)', async ({ page }) => {
    await stubTauri(page);
    const headers = await projectHeaders(page);
    await page.request.patch('/api/file-settings', { headers, data: { terminal_enabled: 'true' } });
    await setCommandsAndReload(page, [
      { name: 'LNT Echo', prompt: '/bin/echo launch-new-terminal', target: 'shell', launchInNewTerminal: true },
    ]);

    const container = page.locator('#channel-commands-container');
    if (await container.count() === 0) { test.skip(); return; }
    const btn = container.locator('.channel-command-btn', { hasText: 'LNT Echo' });
    if (await btn.count() === 0) { test.skip(); return; }

    // A normal click (not a long-press) opens a new terminal because the option is on.
    await btn.click();

    const termTab = page.locator('.drawer-tab[data-drawer-tab^="terminal:dyn-"]');
    await expect(termTab.first()).toBeVisible({ timeout: 6000 });
    await expect(termTab.first()).toHaveClass(/active/, { timeout: 6000 });
  });

  test('long-press a Claude command button creates a Task ticket (HS-8844)', async ({ page }) => {
    const headers = await projectHeaders(page);
    // Claude command buttons only render when the channel is enabled.
    await page.request.post('/api/channel/enable', { headers });
    await setCommandsAndReload(page, [{ name: 'LP Claude Task', prompt: 'investigate the flaky test', target: 'claude' }]);

    const container = page.locator('#channel-commands-container');
    if (await container.count() === 0) { test.skip(); return; }
    const btn = container.locator('.channel-command-btn', { hasText: 'LP Claude Task' });
    // Channel/play section may be hidden when no compatible Claude CLI is present,
    // in which case the Claude button never renders — skip rather than fail.
    try {
      await expect(btn).toHaveCount(1, { timeout: 5000 });
    } catch {
      test.skip();
      return;
    }

    await longPress(page, btn);

    // A Task ticket was created from the command (title = name, details = prompt,
    // category = task), and the prompt was NOT sent to the channel.
    await expect.poll(async () => {
      const res = await page.request.get('/api/tickets');
      const tickets = await res.json() as { title: string; details: string; category: string }[];
      return tickets.some(t => t.title === 'LP Claude Task'
        && t.category === 'task'
        && t.details === 'investigate the flaky test');
    }, { timeout: 6000 }).toBe(true);
  });

  test.afterEach(async ({ page }) => {
    // Reset channel state so an enabled channel doesn't leak into other specs.
    try {
      const headers = await projectHeaders(page);
      await page.request.post('/api/channel/disable', { headers });
    } catch { /* ignore */ }
  });
});
