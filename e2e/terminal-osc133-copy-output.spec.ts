/**
 * HS-7327 — OSC 133 Phase 1b copy-last-output e2e (docs/31-osc133-copy-last-output.md).
 *
 * HS-7268 added a toolbar button on every drawer xterm that copies the most
 * recent OSC 133 command's output range to the clipboard. The button is
 * gated on `inst.shellIntegration.enabled` (set on the first OSC 133 A) AND
 * the per-project `shell_integration_ui` setting.
 *
 * This spec drives a real PTY that emits a complete OSC 133 prompt cycle
 * (A → B → C → output → D;0) via `e2e/fixtures/terminal-osc133.sh` in
 * `MODE=output` and asserts:
 *
 *   1. Before any OSC 133 has fired (MODE=none) the toolbar button stays
 *      hidden — verifies `applyShellIntegrationToolbarVisibility` keeps it
 *      offscreen for non-shell-integrated terminals.
 *   2. After the prompt cycle lands the button reveals; clicking it writes
 *      the C → D range to `navigator.clipboard.writeText`. We stub the
 *      clipboard API so the assertion is deterministic across browsers and
 *      doesn't require Playwright clipboard permissions.
 *   3. The button flashes its `.copied` success class on a successful write.
 */
import { expect, test } from './coverage-fixture.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'terminal-osc133.sh');

let headers: Record<string, string> = {};

const FIXTURE_IDS = ['osc133-output', 'osc133-none'];

/** Open the drawer if it isn't already. Clicking `#command-log-btn` is a
 *  toggle, so a stale "already open" state from a prior test would close the
 *  drawer instead of opening it. Asserting state both ways avoids that flake. */
async function ensureDrawerOpen(page: import('@playwright/test').Page): Promise<void> {
  const panel = page.locator('#command-log-panel');
  if (!(await panel.isVisible())) {
    await page.locator('#command-log-btn').click();
  }
  await expect(panel).toBeVisible({ timeout: 5000 });
}

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
          // HS-7327 — lazy:true so the PTY isn't pre-spawned. We deliberately
          // SKIP `POST /api/terminal/restart` here: restart would spawn the
          // PTY immediately, which then makes the websocket attach the
          // "first attach" with cols/rows — that triggers the HS-6799
          // eager-spawn Ctrl-L redraw, which our one-shot OSC 133 fixture
          // has no way to handle (the script doesn't repaint after Ctrl-L).
          // Letting the websocket attach itself trigger the spawn means the
          // PTY's output is generated *for* the client's pane and lands in
          // the xterm cleanly.
          lazy: true,
        },
      ],
    },
  });
}

test.describe('OSC 133 Phase 1b copy-last-output (HS-7327)', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/projects');
    const projects = await res.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page, request }) => {
    // Tauri stub + clipboard stub. Stubbing navigator.clipboard.writeText
    // sidesteps Playwright's clipboard permissions and gives us a stable
    // assertion target that works headless and across CI environments.
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

    // Clean up dynamic + fixture-id terminals from prior tests.
    try {
      const list = await (await request.get('/api/terminal/list', { headers })).json() as {
        dynamic?: { id: string }[];
      };
      for (const d of list.dynamic ?? []) {
        await request.post('/api/terminal/destroy', { headers, data: { terminalId: d.id } });
      }
    } catch { /* first run */ }
    await destroyAllFixtureTerminals(request);
  });

  test('button stays hidden when no OSC 133 has fired (MODE=none, HS-7327)', async ({ page, request }) => {
    await configureFixtureTerminal(request, 'osc133-none', { MODE: 'none' });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await ensureDrawerOpen(page);

    const tab = page.locator('.drawer-terminal-tab[data-terminal-id="osc133-none"]');
    await expect(tab).toBeVisible({ timeout: 10000 });
    await tab.click();

    const pane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:osc133-none"]');
    await expect(pane).toBeVisible({ timeout: 5000 });
    await expect(pane.locator('.xterm-screen')).toContainText('READY', { timeout: 8000 });

    // The fixture printed text WITHOUT any OSC 133 escape, so the button
    // must stay hidden. Use the inline display:none from the markup.
    const btn = pane.locator('.terminal-copy-output-btn');
    await expect(btn).toBeHidden();
  });

  test('after a complete OSC 133 cycle, clicking the button writes C→D output to clipboard (HS-7327)', async ({ page, request }) => {
    const expectedOutput = 'hotsheet-osc133-marker-line';
    await configureFixtureTerminal(request, 'osc133-output', { MODE: 'output', OUTPUT: expectedOutput });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await ensureDrawerOpen(page);

    const tab = page.locator('.drawer-terminal-tab[data-terminal-id="osc133-output"]');
    await expect(tab).toBeVisible({ timeout: 10000 });
    await tab.click();

    const pane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:osc133-output"]');
    await expect(pane).toBeVisible({ timeout: 5000 });
    // Wait for the output line + READY anchor so we know all three OSC 133
    // marks have been processed by xterm.
    await expect(pane.locator('.xterm-screen')).toContainText(expectedOutput, { timeout: 8000 });
    await expect(pane.locator('.xterm-screen')).toContainText('READY', { timeout: 8000 });

    // Button should be visible now that OSC 133 A has been seen and the
    // shell-integration UI setting defaults to true.
    const btn = pane.locator('.terminal-copy-output-btn');
    await expect(btn).toBeVisible({ timeout: 5000 });

    // Click it — copyLastOutput reads the C→D range from the buffer.
    await btn.click();

    // Assert the clipboard write happened with the expected output.
    await expect.poll(
      async () => page.evaluate(() => (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites.length),
      { timeout: 5000 },
    ).toBeGreaterThan(0);

    const writes = await page.evaluate(() => (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites);
    expect(writes.some(w => w.includes(expectedOutput))).toBe(true);

    // Success path adds the .copied class for a brief flash. Assert before
    // it auto-clears (timeout is generous: the flash is 900ms).
    await expect(btn).toHaveClass(/copied/, { timeout: 1000 });
  });
});
