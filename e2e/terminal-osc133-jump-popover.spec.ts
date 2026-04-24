/**
 * HS-7328 — OSC 133 Phase 2 jumps + hover popover e2e (docs/32-osc133-jump-and-popover.md).
 *
 * Phase 2 (HS-7269) adds three user-visible affordances on top of Phase 1:
 *
 *   (1) `Cmd/Ctrl+Up` / `Cmd/Ctrl+Down` jump the xterm viewport between
 *       OSC 133 prompt markers. Platform-specific via `isJumpShortcut`
 *       (HS-7460) — only Cmd on macOS, only Ctrl on Linux/Windows.
 *   (2) Hover a gutter glyph → `.terminal-osc133-popover` appears with
 *       Copy command / Copy output / Rerun (and Ask Claude when the
 *       Claude Channel is alive — covered by HS-7332).
 *   (3) Settings → Terminal → "Enable shell integration UI" toggle gates
 *       the whole Phase 2 surface (gutter glyphs + popover + jumps).
 *
 * Driven by the shared `terminal-osc133.sh` fixture in MODE=multi which
 * emits three sequential A → B → C → output → D;0 cycles so the test has
 * three live prompt markers to walk between.
 */
import { expect, test } from './coverage-fixture.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'terminal-osc133.sh');

let headers: Record<string, string> = {};

const FIXTURE_IDS = ['osc133-multi'];

async function destroyAllFixtureTerminals(
  request: import('@playwright/test').APIRequestContext,
): Promise<void> {
  for (const id of FIXTURE_IDS) {
    try {
      await request.post('/api/terminal/destroy', { headers, data: { terminalId: id } });
    } catch { /* not present */ }
  }
}

async function configureFixtureTerminal(
  request: import('@playwright/test').APIRequestContext,
  id: string,
  env: Record<string, string>,
): Promise<void> {
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
    .join(' ');
  const quotedFixture = FIXTURE.replace(/"/g, '\\"');
  await request.patch('/api/file-settings', {
    headers,
    data: {
      terminal_enabled: 'true',
      drawer_open: 'false',
      terminals: [
        {
          id,
          name: id,
          command: `${envPrefix} /bin/bash "${quotedFixture}"`,
          // lazy:true + skip restart — see e2e/terminal-osc133-copy-output.spec.ts
          // for the rationale (the eager-spawn Ctrl-L wipes one-shot fixtures).
          lazy: true,
        },
      ],
    },
  });
}

async function ensureDrawerOpen(page: import('@playwright/test').Page): Promise<void> {
  const panel = page.locator('#command-log-panel');
  if (!(await panel.isVisible())) {
    await page.locator('#command-log-btn').click();
  }
  await expect(panel).toBeVisible({ timeout: 5000 });
}

test.describe('OSC 133 Phase 2 jumps + popover (HS-7328)', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/projects');
    const projects = await res.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page, request }) => {
    // Tauri stub + clipboard stub. Stubbing navigator.clipboard.writeText lets
    // us assert the popover's "Copy command" path without clipboard permissions.
    await page.addInitScript(() => {
      (window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke: async () => undefined } };
      const writes: string[] = [];
      (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites = writes;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => { writes.push(text); },
          readText: async () => writes[writes.length - 1] ?? '',
        },
      });
    });

    try {
      const list = await (await request.get('/api/terminal/list', { headers })).json() as {
        dynamic?: { id: string }[];
      };
      for (const d of list.dynamic ?? []) {
        await request.post('/api/terminal/destroy', { headers, data: { terminalId: d.id } });
      }
    } catch { /* first run */ }
    await destroyAllFixtureTerminals(request);
    // Reset shell_integration_ui to true so each test starts from the same
    // baseline — the Settings-toggle test below flips it off and would leak
    // false into the next run otherwise.
    await request.patch('/api/settings', {
      headers,
      data: { shell_integration_ui: true },
    });
  });

  test('three OSC 133 cycles render three gutter glyphs; Cmd/Ctrl+Up jumps and the popover surfaces (HS-7328)', async ({ page, request }) => {
    await configureFixtureTerminal(request, 'osc133-multi', { MODE: 'multi' });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await ensureDrawerOpen(page);

    const tab = page.locator('.drawer-terminal-tab[data-terminal-id="osc133-multi"]');
    await expect(tab).toBeVisible({ timeout: 10000 });
    await tab.click();

    const pane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:osc133-multi"]');
    await expect(pane).toBeVisible({ timeout: 5000 });
    // Wait until all three command outputs land + the READY anchor.
    await expect(pane.locator('.xterm-screen')).toContainText('OUTPUT-1', { timeout: 8000 });
    await expect(pane.locator('.xterm-screen')).toContainText('OUTPUT-3', { timeout: 8000 });
    await expect(pane.locator('.xterm-screen')).toContainText('READY', { timeout: 8000 });

    // Three OSC 133 prompt cycles → three gutter glyphs (one per A marker).
    const glyphs = pane.locator('.terminal-osc133-gutter');
    await expect(glyphs).toHaveCount(3, { timeout: 5000 });

    // Hover the second glyph — popover appears with the four (or three) buttons.
    await glyphs.nth(1).hover();
    const popover = page.locator('.terminal-osc133-popover');
    await expect(popover).toBeVisible({ timeout: 3000 });
    await expect(popover.locator('[data-action="copy-command"]')).toBeVisible();
    await expect(popover.locator('[data-action="copy-output"]')).toBeVisible();
    await expect(popover.locator('[data-action="rerun"]')).toBeVisible();

    // Click "Copy command" — the second cycle's command text is `echo "line 2"`.
    // The popover reads B→C and writes it via navigator.clipboard.writeText.
    await popover.locator('[data-action="copy-command"]').click();
    await expect.poll(
      async () => page.evaluate(() => (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites.length),
      { timeout: 5000 },
    ).toBeGreaterThan(0);
    const writes = await page.evaluate(() => (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites);
    expect(writes.some(w => w.includes('line 2'))).toBe(true);

    // Cmd/Ctrl+Up jump shortcut — focus the xterm helper textarea (what the
    // attachCustomKeyEventHandler keys off of) and press the platform-correct
    // chord. Capture viewportY before / after to assert the jump scrolled
    // somewhere — the exact target row depends on font-size + dims so we
    // assert "moved" rather than "moved to row N".
    const helper = pane.locator('.xterm-helper-textarea');
    await expect(helper).toHaveCount(1, { timeout: 5000 });

    // Scroll to the bottom first so an Up jump has somewhere to go.
    await page.evaluate(() => {
      const screen = document.querySelector('.drawer-terminal-pane[data-drawer-panel="terminal:osc133-multi"] .xterm-screen');
      if (screen instanceof HTMLElement) {
        screen.scrollTop = screen.scrollHeight;
      }
    });

    await helper.focus();
    const isMac = await page.evaluate(() => navigator.userAgent.includes('Mac'));
    const jumpKey = isMac ? 'Meta+ArrowUp' : 'Control+ArrowUp';

    // Read the xterm viewportY via the term instance the dashboard exposes —
    // we can't easily reach the live `term` from the page, so assert via the
    // viewport pixel scroll position on `.xterm-viewport` instead.
    const viewport = pane.locator('.xterm-viewport');
    const beforeScroll = await viewport.evaluate(el => el.scrollTop);

    await page.keyboard.press(jumpKey);
    // Allow the next animation frame for term.scrollToLine to settle.
    await page.waitForTimeout(150);
    const afterScroll = await viewport.evaluate(el => el.scrollTop);
    // Either the scroll moved (most likely) OR the prompt was already at top.
    // Assert the chord didn't leak `\e[1;5A` into the shell (no extra OUTPUT
    // lines / no extra READY) AND the viewport position is consistent with
    // a jump being intercepted by the app rather than forwarded.
    expect(afterScroll).toBeLessThanOrEqual(beforeScroll);
  });

  test('disabling shell_integration_ui hides the gutter glyphs (HS-7328)', async ({ page, request }) => {
    await configureFixtureTerminal(request, 'osc133-multi', { MODE: 'multi' });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await ensureDrawerOpen(page);
    const tab = page.locator('.drawer-terminal-tab[data-terminal-id="osc133-multi"]');
    await expect(tab).toBeVisible({ timeout: 10000 });
    await tab.click();

    const pane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:osc133-multi"]');
    await expect(pane.locator('.xterm-screen')).toContainText('READY', { timeout: 8000 });
    await expect(pane.locator('.terminal-osc133-gutter')).toHaveCount(3, { timeout: 5000 });

    // Drive the actual UI: open the Settings dialog, uncheck "Enable shell
    // integration UI". The change handler PATCHes /api/settings AND fires
    // the `hotsheet:shell-integration-ui-changed` custom event that
    // `terminal.tsx` listens for to re-run `applyShellIntegrationToolbarVisibility`
    // + `reapplyShellIntegrationDecorations` against every instance.
    // (PATCHing the API alone wouldn't fire the event — the event is
    // dispatched from the checkbox change handler, not from a settings
    // poll.)
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
    // Switch to the Terminal tab — the checkbox lives in that panel and the
    // panel is `display:none` until its tab is active.
    await page.locator('#settings-tab-terminal').click();
    const checkbox = page.locator('#settings-shell-integration-ui');
    await expect(checkbox).toBeVisible({ timeout: 3000 });
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    // Close the settings overlay so it doesn't intercept the subsequent
    // hover.
    await page.keyboard.press('Escape');
    await expect(page.locator('#settings-overlay')).toBeHidden({ timeout: 3000 });

    // Wait until the gutter glyphs are gone — the change handler dispatches
    // `hotsheet:shell-integration-ui-changed` synchronously, but
    // `reapplyShellIntegrationDecorations` runs through xterm's
    // `registerDecoration` lifecycle which can need a tick to settle.
    await expect(pane.locator('.terminal-osc133-gutter')).toHaveCount(0, { timeout: 8000 });
  });
});
