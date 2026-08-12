/**
 * HS-7363 — Playwright e2e for the terminal find widget (docs/34-terminal-search.md).
 *
 * Follow-up from HS-7331 (widget ships) and HS-7393 (Esc no longer clears the
 * widget — it just blurs the input). The spec covers:
 *
 *   1. Drawer flow: open drawer → open search → type a multi-hit query →
 *      step through matches with Enter / Shift+Enter → close via the ×
 *      button (NOT Esc, because HS-7393 made Esc a plain blur).
 *   2. Cmd+F routing: focus in the drawer xterm → press Cmd+F → assert the
 *      terminal search input takes focus, not the app-header #search-input.
 *   3. (removed, HS-9626) the dashboard dedicated-view search flow — the
 *      dashboard no longer has a dedicated view (HS-9625 routes a double-click
 *      to the project drawer instead).
 *   4. History flows: recent-query walk (HS-7427) + related drawer-search cases.
 *
 * Fixture `terminal-search-fruits.sh` prints a deterministic four-line block
 * (`apple / banana / apple / apple`) so "apple" has exactly three matches,
 * then `exec sleep 3600` keeps the PTY alive so xterm has a populated
 * scrollback to search across for the full test.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page, TestInfo } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';
import { expectXtermContainsText } from './xtermDiagnostics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRUIT_SCRIPT = path.join(__dirname, 'fixtures', 'terminal-search-fruits.sh');

let headers: Record<string, string> = {};

test.describe('Terminal search widget (HS-7363)', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/projects');
    const projects = await res.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page, request }) => {
    // Tauri stub — both the drawer terminal and the dashboard are Tauri-gated.
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__TAURI__ = {
        core: { invoke: () => Promise.resolve(undefined) },
      };
    });

    // Clear any dynamic terminals left over from earlier tests so tab counts
    // / tile counts are deterministic.
    try {
      const list = await (await request.get('/api/terminal/list', { headers })).json() as {
        dynamic?: { id: string }[];
      };
      for (const d of list.dynamic ?? []) {
        await request.post('/api/terminal/destroy', { headers, data: { terminalId: d.id } });
      }
    } catch { /* first run */ }

    // HS-8419 — lazy-spawn the fruits fixture. Pre-fix this was lazy:false
    // (eager spawn at project boot) so the printf output landed in the
    // ring buffer before the test attached. But on first real attach, the
    // server's `attach.ts` (HS-6799) clears the scrollback and sends
    // Ctrl-L to redraw the prompt at the new client geometry — for the
    // fruits.sh fixture (printf-then-`exec sleep 3600`), that wipes the
    // useful output and the Ctrl-L gets echoed back by the line
    // discipline as `^L` (sleep doesn't consume stdin). Result: xterm
    // shows only `^L` instead of apple/banana. lazy:true defers the
    // spawn to first attach, so the script's printf runs after the
    // client's already subscribed and the bytes stream straight through.
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'false',
        drawer_active_tab: 'commands-log',
        terminals: [
          { id: 'fruits', name: 'Fruits', command: FRUIT_SCRIPT, lazy: true },
        ],
      },
    });

    // Destroy any pre-existing session for this id so a fresh lazy spawn
    // picks up the script. Kill alone would leave session.exitCode set,
    // and the lazy-attach branch in `attach.ts` skips spawn when
    // `session.exitCode !== null`. Destroy removes the session entry
    // entirely so the next attach falls through `!session` and creates +
    // spawns fresh.
    try {
      await request.post('/api/terminal/destroy', { headers, data: { terminalId: 'fruits' } });
    } catch { /* not yet spawned */ }
  });

  /**
   * Shared: open the app, open the drawer, activate the fruits tab, and wait
   * for the three "apple" lines plus "banana" to land in the xterm screen so
   * the SearchAddon has content to match against.
   */
  async function openDrawerAndWaitForFruits(
    page: Page,
    testInfo?: TestInfo,
  ): Promise<void> {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#command-log-btn').click();
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 5000 });

    const tab = page.locator('.drawer-terminal-tab[data-terminal-id="fruits"]');
    await expect(tab).toBeVisible({ timeout: 5000 });
    await tab.click();
    const pane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:fruits"]');
    await expect(pane).toBeVisible({ timeout: 5000 });
    // HS-8421 — wrap the two key assertions with the diagnostic helper so
    // a CI failure attaches the xterm buffer dump to the Playwright report.
    // No behavior change on success.
    await expectXtermContainsText(pane, 'banana', { testInfo, label: 'banana-after-tab-activate' });
    await expectXtermContainsText(pane, 'apple', { testInfo, label: 'apple-after-tab-activate' });
  }

  // 1. Drawer flow — open the widget, type "apple", step through matches with
  // Enter / Shift+Enter, close via the × button (HS-7393 removed the Esc-
  // closes-widget behavior; the close button is now the single explicit
  // close+clear path).
  test('drawer: open + type + step through matches + close via × button', async ({ page }, testInfo) => {
    await openDrawerAndWaitForFruits(page, testInfo);

    const pane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:fruits"]');
    const searchBox = pane.locator('.terminal-search-box');
    const toggle = searchBox.locator('.terminal-search-toggle');
    const input = searchBox.locator('.terminal-search-input');
    const count = searchBox.locator('.terminal-search-count');

    // Collapsed state — the toggle is visible but the widget isn't `.is-open`.
    await expect(searchBox).toBeVisible();
    await expect(searchBox).not.toHaveClass(/is-open/);

    // Click the magnifier toggle — widget expands and the input takes focus.
    await toggle.click();
    await expect(searchBox).toHaveClass(/is-open/);
    await expect(input).toBeFocused();

    // Type "apple" — incremental find on `input` runs findNext, so the count
    // chip populates as soon as the results callback fires.
    await input.fill('apple');
    await expect(count).toHaveText('1/3', { timeout: 3000 });

    // Enter advances 1/3 → 2/3 → 3/3.
    await input.press('Enter');
    await expect(count).toHaveText('2/3', { timeout: 3000 });
    await input.press('Enter');
    await expect(count).toHaveText('3/3', { timeout: 3000 });

    // Shift+Enter steps back 3/3 → 2/3.
    await input.press('Shift+Enter');
    await expect(count).toHaveText('2/3', { timeout: 3000 });

    // HS-7393: pressing Esc in the input should NOT close the widget or
    // clear the query — it blurs the input and leaves everything else as-is.
    await input.press('Escape');
    await expect(searchBox).toHaveClass(/is-open/);
    await expect(input).not.toBeFocused();
    await expect(input).toHaveValue('apple');
    await expect(count).toHaveText('2/3');

    // The × close button is the single explicit close+clear path. Clicking
    // it collapses the widget, clears the input, and wipes the count chip.
    const closeBtn = searchBox.locator('.terminal-search-close');
    await closeBtn.click();
    await expect(searchBox).not.toHaveClass(/is-open/);
    await expect(input).toHaveValue('');
    await expect(count).toHaveText('');
  });

  // 2. Cmd+F routing — when a terminal is focused, the global Cmd/Ctrl+F
  // handler in shortcuts.tsx routes through focusActiveTerminalSearch()
  // instead of the app-header ticket search (#search-input).
  test('Cmd+F with a drawer terminal focused opens the terminal search', async ({ page }, testInfo) => {
    await openDrawerAndWaitForFruits(page, testInfo);

    const pane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:fruits"]');
    const searchBox = pane.locator('.terminal-search-box');
    const input = searchBox.locator('.terminal-search-input');

    // Focus the xterm helper textarea — that's what isTerminalFocused()
    // in shortcuts.tsx keys off of (it walks up looking for `.xterm`).
    const helper = pane.locator('.xterm-helper-textarea');
    await expect(helper).toHaveCount(1, { timeout: 5000 });
    await helper.focus();

    // HS-8419 — `isFindShortcut` in `terminalKeybindings.ts` requires the
    // platform-correct primary modifier (Cmd on Mac, Ctrl elsewhere). Use
    // Playwright's `ControlOrMeta` so the chord works on both the local
    // macOS dev box and the Linux CI runner.
    await page.keyboard.press('ControlOrMeta+f');

    // The terminal-search input should take focus, not the app-header one.
    await expect(input).toBeFocused({ timeout: 3000 });
    await expect(page.locator('#search-input')).not.toBeFocused();
    await expect(searchBox).toHaveClass(/is-open/);
  });

  // 3. HS-9626 — the dashboard dedicated-view search-widget flow (HS-8341) was
  // removed: the dashboard no longer has an in-dashboard dedicated view (a
  // double-click navigates to the project drawer, HS-9625), so there is no
  // `.terminal-dashboard-dedicated-bar` to mount a search widget into. Terminal
  // search is still covered in the drawer flows below and the §34 unit tests.

  // 4. HS-7427 — recent-query history: ArrowUp walks back through three
  // distinct submitted queries in MRU order; ArrowDown returns to the draft.
  // Validates the per-xterm WeakMap, MRU-at-tail ordering, and draft
  // preservation against a real PTY + xterm + SearchAddon stack.
  test('drawer: ArrowUp walks back through three submitted queries (HS-7427)', async ({ page }, testInfo) => {
    await openDrawerAndWaitForFruits(page, testInfo);

    const pane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:fruits"]');
    const searchBox = pane.locator('.terminal-search-box');
    const input = searchBox.locator('.terminal-search-input');

    await searchBox.locator('.terminal-search-toggle').click();
    await expect(input).toBeFocused();

    // Submit three distinct queries via Enter. Each push lands in the per-
    // xterm history ring. The fruits fixture only contains "apple" + "banana"
    // — for the history-walk test the matches don't matter, only that the
    // queries are recorded.
    await input.fill('apple');
    await input.press('Enter');
    await input.fill('banana');
    await input.press('Enter');
    await input.fill('cherry');
    await input.press('Enter');

    // Clear the input back to draft mode (typing also resets the cursor).
    // Use fill('') to drive an `input` event so the widget exits history
    // navigation cleanly.
    await input.fill('');

    // ArrowUp walks back through "cherry" → "banana" → "apple" (MRU-at-tail).
    await input.press('ArrowUp');
    await expect(input).toHaveValue('cherry');
    await input.press('ArrowUp');
    await expect(input).toHaveValue('banana');
    await input.press('ArrowUp');
    await expect(input).toHaveValue('apple');
    // At the oldest entry — further ArrowUp stays put.
    await input.press('ArrowUp');
    await expect(input).toHaveValue('apple');

    // ArrowDown walks back to the most recent entry, then restores draft.
    await input.press('ArrowDown');
    await expect(input).toHaveValue('banana');
    await input.press('ArrowDown');
    await expect(input).toHaveValue('cherry');
    await input.press('ArrowDown');
    await expect(input).toHaveValue('');
  });

  // 5. HS-7426 — match-mode toggles: enable regex, type the pattern `app.e`
  // (the `.` is a regex wildcard that matches any character), and assert the
  // count chip reads "1/3" because all three "apple" lines match.
  test('drawer: regex toggle on `app.e` matches three lines (HS-7426)', async ({ page }, testInfo) => {
    await openDrawerAndWaitForFruits(page, testInfo);

    const pane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:fruits"]');
    const searchBox = pane.locator('.terminal-search-box');
    const input = searchBox.locator('.terminal-search-input');
    const count = searchBox.locator('.terminal-search-count');
    const regexBtn = searchBox.locator('.terminal-search-toggle-btn[data-toggle="regex"]');

    await searchBox.locator('.terminal-search-toggle').click();
    await expect(input).toBeFocused();

    // Enable regex first, then type the pattern. This avoids any
    // toggle-after-result corner cases in xterm's SearchAddon.
    await regexBtn.click();
    await expect(regexBtn).toHaveAttribute('aria-pressed', 'true');

    // Regex `appl.` — `.` matches any char so "apple" (with `e`) matches.
    // The fruits fixture has three "apple" lines so the count is "1/3".
    await input.fill('appl.');
    await expect(count).toHaveText('1/3', { timeout: 3000 });

    // Type an invalid regex `[abc` and assert the input flips to .is-invalid
    // and the count chip shows "err".
    await input.fill('[abc');
    await expect(input).toHaveClass(/is-invalid/);
    await expect(count).toHaveText('err');

    // Disable regex — the literal-string mode ignores the brackets and
    // searches for `[abc` as plain text (no matches in the fruits output).
    await regexBtn.click();
    await expect(input).not.toHaveClass(/is-invalid/);
    await expect(count).toHaveText('0/0');
  });

  // 6. Regression (HS-8341): while in grid view (no dedicated view up)
  // there must be no dedicated-bar search widget anywhere; the sizer is the
  // grid-view control. Pre-HS-8341 this also asserted the
  // `#terminal-dashboard-search-slot` in the app header was hidden, but
  // that slot has been removed.
  test('grid view shows only the sizer; no dedicated-bar widget exists yet', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);

    await expect(page.locator('#terminal-dashboard-sizer')).toBeVisible();
    await expect(page.locator('.terminal-dashboard-dedicated-bar')).toHaveCount(0);
  });

  // 7. HS-7525 — after the HS-7426 match-mode toggles landed in the same flex
  // row as the input + count chip + prev/next + close, the previous 240 px
  // widget left ~50 px of actual typing space. This test asserts the open
  // widget has enough width AND the input itself still has room to type
  // after all the other controls lay out — any future addition that eats
  // back into that budget fails this test before a user has to file a bug.
  test('drawer: open widget is wide enough for a realistic query (HS-7525)', async ({ page }, testInfo) => {
    await openDrawerAndWaitForFruits(page, testInfo);

    const pane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:fruits"]');
    const searchBox = pane.locator('.terminal-search-box');
    const input = searchBox.locator('.terminal-search-input');

    await searchBox.locator('.terminal-search-toggle').click();
    await expect(searchBox).toHaveClass(/is-open/);
    await expect(input).toBeFocused();

    // The `.is-open` class drives a 200ms CSS width transition from 28px
    // (collapsed) to 380px (open). Poll `getBoundingClientRect().width`
    // until it settles — toHaveClass resolves instantly on the class flip,
    // well before the animation actually runs.
    // 340px floor leaves ~40px of wiggle room under the current 380px spec,
    // but is well clear of the old 240px that triggered the bug report.
    await expect.poll(
      async () => searchBox.evaluate((el) => el.getBoundingClientRect().width),
      { timeout: 2000 },
    ).toBeGreaterThanOrEqual(340);
    // Input must have at least ~160px of clear typing space after the
    // toggles + count chip + chevrons + close button consume their share.
    // The pre-fix regression produced ~50px here; 160 catches it without
    // being brittle against small icon-size tweaks.
    await expect.poll(
      async () => input.evaluate((el) => el.getBoundingClientRect().width),
      { timeout: 2000 },
    ).toBeGreaterThanOrEqual(160);
  });

  // 8. (removed, HS-9626) the HS-7526 "Esc in the dedicated-view search field
  // blurs the input instead of exiting" test — the dashboard no longer has a
  // dedicated view or its search field (HS-9625 routes a double-click to the
  // project drawer). The §36 drawer grid keeps its own dedicated view + Esc
  // handling, tested separately.
});
