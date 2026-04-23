/**
 * HS-7196 + HS-7197 — e2e coverage for the drawer terminal's Phase-1
 * HS-6473 indicators. Both flows worked in manual testing but had no
 * Playwright regression coverage (called out in the HS-7162 audit).
 *
 * HS-7196: OSC 0/2 title-change escape (`\x1b]0;Title\x07`) updates the
 * in-pane toolbar's runtime title while the drawer tab keeps the
 * configured name — the toolbar is what follows the running process
 * because long runtime titles are unreadable in the narrow tab slot.
 *
 * HS-7197: a bell character (`\x07`) landing on an inactive drawer tab
 * flips `.has-bell` on the tab + injects the `.drawer-tab-bell` glyph, and
 * activating the tab clears it (both server-side via
 * `POST /api/terminal/clear-bell` and locally via `inst.hasBell = false`).
 */
import { expect, test } from './coverage-fixture.js';

let headers: Record<string, string> = {};

test.describe('Drawer terminal — OSC title + bell indicators', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/projects');
    const projects = await res.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page, request }) => {
    // Tauri stub — the drawer terminal is Tauri-only (HS-6437). Playwright
    // runs Chromium, so we have to spoof `__TAURI__` before the bundle loads.
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__TAURI__ = {
        core: { invoke: async () => undefined },
      };
    });

    // Clean up any dynamic terminals left behind by earlier tests.
    try {
      const list = await (await request.get('/api/terminal/list', { headers })).json() as {
        dynamic?: { id: string }[];
      };
      for (const d of list.dynamic ?? []) {
        await request.post('/api/terminal/destroy', { headers, data: { terminalId: d.id } });
      }
    } catch { /* fine on first run */ }
  });

  /**
   * HS-7196: the terminal runs `printf '\033]0;Custom Title\007'` and then
   * sleeps so the PTY stays alive long enough for xterm's parser to fire
   * `onTitleChange` and the client to write the runtime title into the
   * in-pane toolbar. `\033` (octal 27 = ESC) is the portable way to emit an
   * escape sequence from `/bin/sh`'s `printf` — POSIX printf doesn't parse
   * `\xNN` hex escapes, only named + octal. `\007` is the OSC terminator.
   */
  test('OSC 0 title-change updates in-pane toolbar but not drawer tab (HS-7196)', async ({ page, request }) => {
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'false',
        drawer_active_tab: 'commands-log',
        terminals: [
          {
            id: 'osc',
            // Server always spawns via `/bin/sh -c <command>` (see
            // `defaultFactory` in registry.ts), so the command string itself
            // is shell source. Octal escapes are portable in sh's printf.
            //
            // The leading `sleep 2` is load-bearing: HS-6799 first-attach
            // cleanup clears the PTY's scrollback + writes Ctrl-L once the
            // real client attaches. An immediate printf would push the OSC
            // title bytes into the buffer BEFORE the client attached, and
            // the cleanup would wipe them. Sleeping first lets the attach
            // happen, then emits the title so xterm sees the bytes live.
            name: 'Configured Name',
            command: 'sleep 2; printf "\\033]0;Custom Title\\007"; sleep 30',
            lazy: true,
          },
        ],
      },
    });
    // Kill any stale PTY from a previous run so the new command is the one
    // that spawns this time.
    try { await request.post('/api/terminal/restart', { headers, data: { terminalId: 'osc' } }); } catch { /* ignore */ }

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const panel = page.locator('#command-log-panel');
    if (!(await panel.isVisible())) await page.locator('#command-log-btn').click();
    await expect(panel).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#drawer-terminal-tabs-wrap')).toBeVisible({ timeout: 5000 });

    const tab = page.locator('.drawer-terminal-tab[data-terminal-id="osc"]');
    await expect(tab).toBeVisible({ timeout: 5000 });
    await tab.click();

    const pane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:osc"]');
    await expect(pane).toBeVisible({ timeout: 5000 });

    // The in-pane toolbar follows the OSC title.
    await expect(pane.locator('.terminal-label')).toHaveText('Custom Title', { timeout: 8000 });

    // The drawer tab keeps the configured name — this is the deliberate
    // HS-6473 follow-up (noisy per-cwd titles are unreadable in a tab).
    await expect(tab.locator('.drawer-tab-label')).toHaveText('Configured Name');
  });

  /**
   * HS-7197: a bell character landing on an inactive drawer tab must flip
   * the tab's `.has-bell` class and inject `.drawer-tab-bell`. Selecting the
   * tab clears both (and fires `POST /api/terminal/clear-bell`).
   *
   * Reproducer: two configured terminals; one (`bell-src`) runs a script that
   * sleeps then emits `\007`. Activating it starts the sleep; switching to
   * the other tab makes it inactive; when the bell fires its tab gains the
   * indicators; re-activating clears them.
   */
  test('bell on inactive drawer tab shows .has-bell glyph, cleared on activation (HS-7197)', async ({ page, request }) => {
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'false',
        drawer_active_tab: 'commands-log',
        terminals: [
          {
            id: 'bell-src',
            name: 'BellSrc',
            // Short sleep so the test doesn't stall; bell fires after we've
            // switched to the other tab.
            command: 'sleep 1.5; printf "\\007"; sleep 30',
            lazy: true,
          },
          {
            id: 'bell-other',
            name: 'Other',
            command: 'sleep 60',
            lazy: true,
          },
        ],
      },
    });
    try { await request.post('/api/terminal/restart', { headers, data: { terminalId: 'bell-src' } }); } catch { /* ignore */ }
    try { await request.post('/api/terminal/restart', { headers, data: { terminalId: 'bell-other' } }); } catch { /* ignore */ }

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const panel = page.locator('#command-log-panel');
    if (!(await panel.isVisible())) await page.locator('#command-log-btn').click();
    await expect(panel).toBeVisible({ timeout: 5000 });
    // Wait for the Tauri-gated terminal-tabs wrap to be revealed by
    // `applyTerminalTabVisibility`. Otherwise the tabs exist in the DOM but
    // their ancestor wrap is `display:none` and Playwright's visibility check
    // rightly reports them hidden.
    await expect(page.locator('#drawer-terminal-tabs-wrap')).toBeVisible({ timeout: 5000 });

    const bellTab = page.locator('.drawer-terminal-tab[data-terminal-id="bell-src"]');
    const otherTab = page.locator('.drawer-terminal-tab[data-terminal-id="bell-other"]');
    await expect(bellTab).toBeVisible({ timeout: 5000 });
    await expect(otherTab).toBeVisible({ timeout: 5000 });

    // Activate the bell-src tab first — this mounts its xterm, attaches the
    // WebSocket, and starts the PTY's sleep. Without this step the bell
    // would fire server-side but the client's onBell wouldn't see it (no
    // mounted xterm to process the byte).
    await bellTab.click();
    await expect(page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:bell-src"]')).toBeVisible({ timeout: 5000 });

    // Switch to the other tab BEFORE the bell fires so the bell lands on an
    // inactive tab. The other tab's xterm mounts on activation.
    await otherTab.click();
    await expect(otherTab).toHaveClass(/active/, { timeout: 3000 });

    // Wait for the bell to arrive + the has-bell class to flip.
    await expect(bellTab).toHaveClass(/has-bell/, { timeout: 5000 });
    await expect(bellTab.locator('.drawer-tab-bell')).toBeVisible();

    // Activating the bell-src tab clears the bell.
    await bellTab.click();
    await expect(bellTab).not.toHaveClass(/has-bell/, { timeout: 3000 });
    await expect(bellTab.locator('.drawer-tab-bell')).toHaveCount(0);
  });
});
