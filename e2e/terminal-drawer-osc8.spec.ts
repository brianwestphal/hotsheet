/**
 * HS-7274 — OSC 8 hyperlinks + plain-URL external-open e2e.
 *
 * HS-7263 wired xterm's native OSC 8 `linkHandler` through a new
 * `openExternalUrl` helper in `tauriIntegration.tsx` so hyperlink clicks go
 * through the Tauri `open_url` command (WKWebView silently no-ops
 * `window.open`, so the default WebLinksAddon path dropped every click on the
 * desktop build). The same refactor swapped the default `WebLinksAddon`
 * handler on every xterm instance for the same helper, incidentally fixing a
 * pre-existing "plain URLs don't open" report.
 *
 * This spec installs a Tauri `invoke` stub before the bundle loads and drives
 * a real eager-spawn PTY that prints:
 *   1. An OSC 8 wrapped "CLICK-OSC8-LINK" that resolves to a known URL.
 *   2. A bare plain URL on its own line.
 * It then clicks the hyperlinked text and asserts `invoke('open_url', ...)`
 * was called with the wrapped URL; then clicks the plain URL and asserts a
 * second `invoke('open_url', ...)` call with the plain URL.
 */
import { expect, test } from './coverage-fixture.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'terminal-osc8.sh');

const OSC8_URL = 'https://osc8-link.example.com/hello';
const PLAIN_URL = 'https://plain-url.example.com/world';

type InvokeCall = { cmd: string; args: Record<string, unknown> };

let headers: Record<string, string> = {};

test.describe('Terminal drawer OSC 8 + plain URL external open (HS-7274)', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/projects');
    const projects = await res.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page, request }) => {
    // Install the Tauri invoke stub BEFORE the bundle loads so every call from
    // `openExternalUrl` is captured. `__invokeCalls` is our assertion target.
    await page.addInitScript(() => {
      const calls: InvokeCall[] = [];
      (window as unknown as { __invokeCalls: InvokeCall[] }).__invokeCalls = calls;
      (window as unknown as { __TAURI__: unknown }).__TAURI__ = {
        core: {
          invoke: async (cmd: string, args: Record<string, unknown>) => {
            calls.push({ cmd, args: args ?? {} });
            return undefined;
          },
        },
      };
    });

    // Tear down earlier dynamic terminals.
    try {
      const list = await (await request.get('/api/terminal/list', { headers })).json() as {
        dynamic?: { id: string }[];
      };
      for (const d of list.dynamic ?? []) {
        await request.post('/api/terminal/destroy', { headers, data: { terminalId: d.id } });
      }
    } catch { /* fine on first run */ }

    // Configure a single eager-spawn terminal running the OSC 8 fixture. We
    // pass HYPERLINK_URL / PLAIN_URL via env through bash -c so the spawned
    // shell has them available to the script.
    const quotedFixture = FIXTURE.replace(/"/g, '\\"');
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'false',
        terminals: [
          {
            id: 'osc8',
            name: 'OSC8',
            command: `HYPERLINK_URL="${OSC8_URL}" PLAIN_URL="${PLAIN_URL}" /bin/bash "${quotedFixture}"`,
            lazy: false,
          },
        ],
      },
    });

    // Restart any pre-existing PTY so a fresh one picks up the new command.
    try {
      await request.post('/api/terminal/restart', { headers, data: { terminalId: 'osc8' } });
    } catch { /* first run */ }
  });

  test('OSC 8 link click invokes open_url with the wrapped URL, plain URL click invokes open_url with the plain URL', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Open drawer.
    await page.locator('#command-log-btn').click();
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 5000 });

    const tab = page.locator('.drawer-terminal-tab[data-terminal-id="osc8"]');
    await expect(tab).toBeVisible({ timeout: 5000 });
    await tab.click();

    const pane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:osc8"]');
    await expect(pane).toBeVisible({ timeout: 5000 });

    // Wait for the fixture's READY marker — by then both the OSC 8 link line
    // and the plain-URL line are in the scrollback.
    await expect(pane.locator('.xterm-screen')).toContainText(/CLICK-OSC8-LINK/, { timeout: 10000 });
    await expect(pane.locator('.xterm-screen')).toContainText(/plain-url\.example\.com/, { timeout: 10000 });
    await expect(pane.locator('.xterm-screen')).toContainText(/READY/, { timeout: 10000 });

    // Click the OSC 8 hyperlink text. xterm.js layers its canvas above the
    // DOM text row, so clicking the text locator's center box hits the canvas
    // (which intercepts pointer events). We resolve the row's bounding box
    // and drive `page.mouse.click(x, y)` at that coordinate so the click is
    // delivered to xterm's own mouse tracker (which fires the OSC 8
    // linkHandler) regardless of which layer is on top.
    const osc8Text = pane.locator('.xterm-screen >> text=CLICK-OSC8-LINK').first();
    await expect(osc8Text).toBeVisible();
    const osc8Box = await osc8Text.boundingBox();
    expect(osc8Box).not.toBeNull();
    await page.mouse.click(osc8Box!.x + osc8Box!.width / 2, osc8Box!.y + osc8Box!.height / 2);

    // Assert invoke('open_url', { url: OSC8_URL }) was called.
    await expect.poll(
      async () => page.evaluate(() => (window as unknown as { __invokeCalls: InvokeCall[] }).__invokeCalls ?? []),
      { timeout: 5000 },
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({ cmd: 'open_url', args: expect.objectContaining({ url: OSC8_URL }) }),
    ]));

    // Click the plain URL. WebLinksAddon auto-detects http(s) runs and
    // dispatches its handler with the URI. Our custom handler (set in
    // mountXterm, not WebLinksAddon's default window.open) routes through
    // openExternalUrl, so invoke('open_url', { url: PLAIN_URL }) fires.
    const plainText = pane.locator('.xterm-screen >> text=plain-url.example.com').first();
    await expect(plainText).toBeVisible();
    const plainBox = await plainText.boundingBox();
    expect(plainBox).not.toBeNull();
    await page.mouse.click(plainBox!.x + plainBox!.width / 2, plainBox!.y + plainBox!.height / 2);

    await expect.poll(
      async () => page.evaluate(() => (window as unknown as { __invokeCalls: InvokeCall[] }).__invokeCalls ?? []),
      { timeout: 5000 },
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({ cmd: 'open_url', args: expect.objectContaining({ url: PLAIN_URL }) }),
    ]));
  });
});
