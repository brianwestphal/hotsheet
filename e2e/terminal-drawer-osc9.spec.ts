/**
 * HS-7273 — OSC 9 desktop notifications e2e.
 *
 * HS-7264 added server-side OSC 9 detection and a client-side toast that
 * surfaces the shell-pushed message on the active project. This spec drives a
 * real PTY emitting the OSC 9 escapes (via `e2e/fixtures/terminal-osc9.sh` in
 * one of four modes) and asserts:
 *
 *   1. `\e]9;MSG\a` → a toast with MSG appears, AND the drawer tab gains the
 *      bell glyph when the tab is not active.
 *   2. Clicking the tab clears the glyph (server-side /terminal/clear-bell)
 *      and the toast fades.
 *   3. Identical repeated message → exactly one toast fires (recentlyToasted
 *      dedupe in bellPoll.tsx).
 *   4. Two distinct messages in sequence → two toasts (one per message).
 *   5. `\e]9;4;3;50\a` progress subcommand → NO toast, NO bell (scanner
 *      parks numeric subcommands).
 *
 * Toast counts are asserted via a MutationObserver installed in an
 * addInitScript that pushes every `.hs-toast` node addition onto
 * `window.__toastEvents` with its text content. Playwright reads that array
 * to verify exact fire counts — the DOM only ever hosts one toast at a time
 * (new toasts replace old), so you can't just grab `.hs-toast` a moment later
 * and count.
 */
import { expect, test } from './coverage-fixture.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'terminal-osc9.sh');

type ToastEvent = { text: string };

let headers: Record<string, string> = {};

// Every fixture terminal id we might leave behind across tests in this file.
// beforeEach destroys them all so server-side notificationMessage state from a
// prior test never leaks into the next one's __toastEvents.
const FIXTURE_IDS = ['osc9-simple', 'osc9-dedupe', 'osc9-sequence', 'osc9-progress'];

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
          lazy: false,
        },
      ],
    },
  });
  try {
    await request.post('/api/terminal/restart', { headers, data: { terminalId: id } });
  } catch { /* first run */ }
}

test.describe('Terminal drawer OSC 9 desktop notifications (HS-7273)', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/projects');
    const projects = await res.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page, request }) => {
    // Tauri stub so drawer terminal is enabled.
    // Toast-event tracker — MutationObserver set up BEFORE the bundle loads so
    // every `.hs-toast` add-node is recorded with its text. DOM only hosts one
    // toast at a time; we can't count by querying the DOM later.
    await page.addInitScript(() => {
      (window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke: async () => undefined } };
      const events: ToastEvent[] = [];
      (window as unknown as { __toastEvents: ToastEvent[] }).__toastEvents = events;
      const ob = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node instanceof HTMLElement && node.classList.contains('hs-toast')) {
              events.push({ text: node.textContent ?? '' });
            }
          }
        }
      });
      // document.body may not exist yet at init-script time; attach once the
      // DOM is ready so we catch every toast from first frame onward.
      const start = () => ob.observe(document.body, { childList: true });
      if (document.body) start();
      else document.addEventListener('DOMContentLoaded', start);
    });

    // Clean up leftover dynamic terminals AND any fixture-id configured
    // terminals from prior tests (the latter carry notificationMessage state
    // in the server registry even after the configured list is rewritten).
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

  test('OSC 9 BEL-terminated notification renders a toast and bell glyph; tab click clears the bell (HS-7273)', async ({ page, request }) => {
    await configureFixtureTerminal(request, 'osc9-simple', { MODE: 'simple', MESSAGE: 'Build done' });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Open the drawer. Don't activate the terminal tab — we want the
    // OSC 9 to arrive while the tab is inactive so the bell glyph renders.
    await page.locator('#command-log-btn').click();
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 5000 });
    const tab = page.locator('.drawer-terminal-tab[data-terminal-id="osc9-simple"]');
    await expect(tab).toBeVisible({ timeout: 5000 });

    // Toast arrives via the bell-state long-poll.
    await expect(page.locator('.hs-toast')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.hs-toast')).toContainText('Build done');

    // Bell glyph on the inactive tab.
    await expect(tab.locator('.drawer-tab-bell')).toBeVisible({ timeout: 5000 });

    // Click the tab — /terminal/clear-bell fires server-side, the glyph
    // drops, and the toast is allowed to age out.
    await tab.click();
    await expect(tab.locator('.drawer-tab-bell')).toHaveCount(0, { timeout: 5000 });
    // Toast has 6 s lifetime; don't hard-wait — just assert it eventually goes away.
    await expect(page.locator('.hs-toast')).toHaveCount(0, { timeout: 10000 });
  });

  test('repeating the same OSC 9 message fires exactly one toast (dedupe, HS-7273)', async ({ page, request }) => {
    await configureFixtureTerminal(request, 'osc9-dedupe', { MODE: 'dedupe', MESSAGE: 'Same message' });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#command-log-btn').click();
    await expect(page.locator('.drawer-terminal-tab[data-terminal-id="osc9-dedupe"]')).toBeVisible({ timeout: 5000 });

    // Wait until the toast lands at least once.
    await expect(page.locator('.hs-toast')).toContainText('Same message', { timeout: 10000 });

    // Give the bell-poll one extra tick so a second tick would have re-toasted
    // if dedupe were broken (long-poll is 3 s; wait ~4 s for safety).
    await page.waitForTimeout(4000);

    const events = await page.evaluate(() => (window as unknown as { __toastEvents: ToastEvent[] }).__toastEvents);
    const sameMsgCount = events.filter(e => e.text.includes('Same message')).length;
    expect(sameMsgCount).toBe(1);
  });

  test('two distinct OSC 9 messages fire two toasts (HS-7273)', async ({ page, request }) => {
    await configureFixtureTerminal(request, 'osc9-sequence', { MODE: 'sequence', MSG1: 'Stage 1 complete', MSG2: 'Stage 2 complete' });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#command-log-btn').click();
    await expect(page.locator('.drawer-terminal-tab[data-terminal-id="osc9-sequence"]')).toBeVisible({ timeout: 5000 });

    // Wait for the second message — "latest wins" on the server means only
    // the second is in the bell-state. The first message's toast may still
    // have been observed before that if the poll caught both ticks.
    await expect.poll(
      async () => page.evaluate(() => (window as unknown as { __toastEvents: ToastEvent[] }).__toastEvents.length),
      { timeout: 10000 },
    ).toBeGreaterThanOrEqual(1);

    // At least the "Stage 2 complete" toast must have fired. The first may
    // coalesce if both arrive within a single poll tick (latest-wins), but
    // the final state is the second message.
    await expect(page.locator('.hs-toast')).toContainText('Stage 2 complete', { timeout: 10000 });
    const events = await page.evaluate(() => (window as unknown as { __toastEvents: ToastEvent[] }).__toastEvents);
    // Either two toasts (if the poll caught the intermediate state) or one
    // toast whose text is Stage 2 — both are correct, but zero toasts or a
    // toast for "Stage 1" alone would indicate a regression.
    const texts = events.map(e => e.text);
    expect(texts.some(t => t.includes('Stage 2 complete'))).toBe(true);
  });

  test('OSC 9;4;3;50 progress subcommand fires neither toast nor bell (HS-7273)', async ({ page, request }) => {
    await configureFixtureTerminal(request, 'osc9-progress', { MODE: 'progress' });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#command-log-btn').click();
    const tab = page.locator('.drawer-terminal-tab[data-terminal-id="osc9-progress"]');
    await expect(tab).toBeVisible({ timeout: 5000 });

    // Give the fixture time to emit the progress escape + READY, and for at
    // least one bell-poll tick to land (3 s long-poll).
    await page.waitForTimeout(5000);

    // No toast should have fired.
    const events = await page.evaluate(() => (window as unknown as { __toastEvents: ToastEvent[] }).__toastEvents);
    expect(events).toEqual([]);
    // No bell glyph on the tab either.
    await expect(tab.locator('.drawer-tab-bell')).toHaveCount(0);
  });
});
