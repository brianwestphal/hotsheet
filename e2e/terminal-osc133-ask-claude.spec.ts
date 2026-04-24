/**
 * HS-7332 — OSC 133 Phase 3 Ask Claude e2e (docs/33-osc133-ask-claude.md).
 *
 * Phase 3 (HS-7270) adds a fourth button to the gutter-glyph popover —
 * "Ask Claude" — that's gated on `isChannelAlive()` at popover open time.
 * Clicking it dispatches a canonical diagnose-and-fix prompt to the
 * Claude Channel via `triggerChannelAndMarkBusy`.
 *
 * Two tests:
 *
 *   1. Channel alive (stubbed via `page.route` returning `alive:true`) →
 *      popover surfaces the "Ask Claude" button. Clicking it POSTs to
 *      `/api/channel/trigger` with the canonical prompt body containing
 *      the command text, exit code, and output snippet.
 *   2. Channel dead (default — no MCP connected) → popover does NOT
 *      include the "Ask Claude" button (the gate at popover open keeps it
 *      out of the DOM entirely).
 *
 * Driven by the shared `terminal-osc133.sh` fixture in `MODE=fail` so the
 * popover targets a non-zero-exit-code record (the typical Ask Claude
 * scenario).
 */
import { expect, test } from './coverage-fixture.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'terminal-osc133.sh');

let headers: Record<string, string> = {};

const FIXTURE_IDS = ['osc133-fail-alive', 'osc133-fail-dead'];

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
        { id, name: id, command: `${envPrefix} /bin/bash "${quotedFixture}"`, lazy: true },
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

test.describe('OSC 133 Phase 3 Ask Claude (HS-7332)', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/projects');
    const projects = await res.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page, request }) => {
    // Tauri stub.
    await page.addInitScript(() => {
      (window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke: async () => undefined } };
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
    await request.patch('/api/settings', {
      headers,
      data: { shell_integration_ui: true },
    });
  });

  test('channel alive: popover surfaces Ask Claude + click POSTs the rendered prompt to /api/channel/trigger (HS-7332)', async ({ page, request }) => {
    // Capture any POST to /api/channel/trigger and short-circuit it so the
    // server doesn't try to reach a real MCP. The body is recorded in
    // window.__channelTriggers for the assertion below.
    await page.addInitScript(() => {
      (window as unknown as { __channelTriggers: unknown[] }).__channelTriggers = [];
    });
    await page.route(/\/api\/channel\/status/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled: true, alive: true }),
      });
    });
    await page.route(/\/api\/channel\/trigger/, async (route) => {
      const body = route.request().postDataJSON() as unknown;
      await page.evaluate((b) => {
        (window as unknown as { __channelTriggers: unknown[] }).__channelTriggers.push(b);
      }, body);
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    // Stub the secondary endpoints the trigger flow hits so they don't 404.
    await page.route(/\/api\/ensure-skills/, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });

    await configureFixtureTerminal(request, 'osc133-fail-alive', {
      MODE: 'fail',
      OUTPUT: 'phase3-ask-claude-marker',
      EXIT_CODE: '7',
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await ensureDrawerOpen(page);
    const tab = page.locator('.drawer-terminal-tab[data-terminal-id="osc133-fail-alive"]');
    await expect(tab).toBeVisible({ timeout: 10000 });
    await tab.click();

    const pane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:osc133-fail-alive"]');
    await expect(pane.locator('.xterm-screen')).toContainText('phase3-ask-claude-marker', { timeout: 8000 });
    await expect(pane.locator('.xterm-screen')).toContainText('READY', { timeout: 8000 });

    // One OSC 133 prompt cycle → one gutter glyph (red because exit:7).
    const glyphs = pane.locator('.terminal-osc133-gutter');
    await expect(glyphs).toHaveCount(1, { timeout: 5000 });
    await expect(glyphs.first()).toHaveClass(/terminal-osc133-gutter-failure/);

    // Wait for the channel-status stub to have been hit at least once so
    // initChannel + checkChannelDone has had a chance to set channelAliveLocal.
    // The init fetch is fired when the bundle wires up; allow a brief tick.
    await page.waitForTimeout(500);

    // Hover the glyph — popover surfaces with all four buttons (channel
    // alive gate is satisfied via the stubbed /api/channel/status).
    await glyphs.first().hover();
    const popover = page.locator('.terminal-osc133-popover');
    await expect(popover).toBeVisible({ timeout: 3000 });
    const askBtn = popover.locator('[data-action="ask-claude"]');
    await expect(askBtn).toBeVisible({ timeout: 3000 });

    // Click Ask Claude — the click handler reads the command + output via
    // readRecordCommand / readRecordOutput, packs them through
    // buildAskClaudePrompt, and POSTs the result to /api/channel/trigger.
    await askBtn.click();

    await expect.poll(
      async () => page.evaluate(() => (window as unknown as { __channelTriggers: unknown[] }).__channelTriggers.length),
      { timeout: 5000 },
    ).toBeGreaterThan(0);

    const triggers = await page.evaluate(() => (window as unknown as { __channelTriggers: { message?: string }[] }).__channelTriggers);
    expect(triggers).toHaveLength(1);
    const message = triggers[0].message ?? '';
    // The canonical prompt template from buildAskClaudePrompt mentions the
    // command, exit code, and output. We assert each piece is present rather
    // than the exact rendered string so prompt tweaks don't break the test.
    expect(message).toContain('false');           // the failing command from MODE=fail
    expect(message).toContain('exited with code 7'); // the EXIT_CODE we set
    expect(message).toContain('phase3-ask-claude-marker'); // the output snippet
  });

  test('channel dead: popover does NOT include the Ask Claude button (HS-7332)', async ({ page, request }) => {
    // Default channel state — no stub means the real /api/channel/status
    // returns enabled:false alive:false in a CI / local non-MCP environment.
    // To make the test deterministic we stub it explicitly to alive:false.
    await page.route(/\/api\/channel\/status/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled: true, alive: false }),
      });
    });

    await configureFixtureTerminal(request, 'osc133-fail-dead', {
      MODE: 'fail',
      OUTPUT: 'phase3-channel-dead-marker',
      EXIT_CODE: '1',
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await ensureDrawerOpen(page);
    const tab = page.locator('.drawer-terminal-tab[data-terminal-id="osc133-fail-dead"]');
    await expect(tab).toBeVisible({ timeout: 10000 });
    await tab.click();

    const pane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:osc133-fail-dead"]');
    await expect(pane.locator('.xterm-screen')).toContainText('phase3-channel-dead-marker', { timeout: 8000 });
    await expect(pane.locator('.xterm-screen')).toContainText('READY', { timeout: 8000 });

    const glyphs = pane.locator('.terminal-osc133-gutter');
    await expect(glyphs).toHaveCount(1, { timeout: 5000 });

    await glyphs.first().hover();
    const popover = page.locator('.terminal-osc133-popover');
    await expect(popover).toBeVisible({ timeout: 3000 });
    // The other three buttons are present.
    await expect(popover.locator('[data-action="copy-command"]')).toBeVisible();
    await expect(popover.locator('[data-action="copy-output"]')).toBeVisible();
    await expect(popover.locator('[data-action="rerun"]')).toBeVisible();
    // But Ask Claude is NOT — the popover's open-time gate keeps it out of
    // the DOM entirely when isChannelAlive() returns false.
    await expect(popover.locator('[data-action="ask-claude"]')).toHaveCount(0);
  });
});
