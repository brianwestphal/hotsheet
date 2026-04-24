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
 *   3. Dedicated view flow: open the dashboard, double-click a tile to enter
 *      the dedicated view, assert the app-header search slot is visible and
 *      the sizer is hidden, run a search, then Back-button out and assert
 *      the slot is hidden again and the sizer is restored.
 *   4. Grid-view regression: the app-header slot must stay hidden while in
 *      grid view (sizer visible instead).
 *
 * Fixture `terminal-search-fruits.sh` prints a deterministic four-line block
 * (`apple / banana / apple / apple`) so "apple" has exactly three matches,
 * then `exec sleep 3600` keeps the PTY alive so xterm has a populated
 * scrollback to search across for the full test.
 */
import { expect, test } from './coverage-fixture.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
        core: { invoke: async () => undefined },
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

    // Eager-spawn the fruits fixture so the PTY exists at project boot and
    // the scrollback is populated by the time the drawer / dashboard attach.
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'false',
        drawer_active_tab: 'commands-log',
        terminals: [
          { id: 'fruits', name: 'Fruits', command: FRUIT_SCRIPT, lazy: false },
        ],
      },
    });

    // Restart any pre-existing PTY for this id so a fresh PTY runs the script
    // (an earlier run may have changed the command).
    try {
      await request.post('/api/terminal/restart', { headers, data: { terminalId: 'fruits' } });
    } catch { /* not yet spawned */ }
  });

  /**
   * Shared: open the app, open the drawer, activate the fruits tab, and wait
   * for the three "apple" lines plus "banana" to land in the xterm screen so
   * the SearchAddon has content to match against.
   */
  async function openDrawerAndWaitForFruits(page: import('@playwright/test').Page): Promise<void> {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#command-log-btn').click();
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 5000 });

    const tab = page.locator('.drawer-terminal-tab[data-terminal-id="fruits"]');
    await expect(tab).toBeVisible({ timeout: 5000 });
    await tab.click();
    const pane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:fruits"]');
    await expect(pane).toBeVisible({ timeout: 5000 });
    await expect(pane.locator('.xterm-screen')).toContainText('banana', { timeout: 8000 });
    await expect(pane.locator('.xterm-screen')).toContainText('apple', { timeout: 8000 });
  }

  // 1. Drawer flow — open the widget, type "apple", step through matches with
  // Enter / Shift+Enter, close via the × button (HS-7393 removed the Esc-
  // closes-widget behaviour; the close button is now the single explicit
  // close+clear path).
  test('drawer: open + type + step through matches + close via × button', async ({ page }) => {
    await openDrawerAndWaitForFruits(page);

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
  test('Cmd+F with a drawer terminal focused opens the terminal search', async ({ page }) => {
    await openDrawerAndWaitForFruits(page);

    const pane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:fruits"]');
    const searchBox = pane.locator('.terminal-search-box');
    const input = searchBox.locator('.terminal-search-input');

    // Focus the xterm helper textarea — that's what isTerminalFocused()
    // in shortcuts.tsx keys off of (it walks up looking for `.xterm`).
    const helper = pane.locator('.xterm-helper-textarea');
    await expect(helper).toHaveCount(1, { timeout: 5000 });
    await helper.focus();

    await page.keyboard.press('Meta+f');

    // The terminal-search input should take focus, not the app-header one.
    await expect(input).toBeFocused({ timeout: 3000 });
    await expect(page.locator('#search-input')).not.toBeFocused();
    await expect(searchBox).toHaveClass(/is-open/);
  });

  // 3. Dedicated view flow — dashboard shows the `#terminal-dashboard-search-slot`
  // only while the dedicated view is up (mutually exclusive with the sizer).
  // Exiting via the Back button puts the sizer back and hides the slot.
  test('dedicated view exposes the header search slot; exit restores the sizer', async ({ page }) => {
    await openDrawerAndWaitForFruits(page);

    // Enter the dashboard. In grid view: sizer visible, header search hidden.
    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);
    await expect(page.locator('#terminal-dashboard-sizer')).toBeVisible();
    await expect(page.locator('#terminal-dashboard-search-slot')).toBeHidden();

    // Double-click the fruits tile to enter the dedicated view.
    const tile = page.locator('.terminal-dashboard-tile[data-terminal-id="fruits"]');
    await expect(tile).toHaveClass(/terminal-dashboard-tile-alive/, { timeout: 5000 });
    await tile.dblclick();

    // Dedicated overlay is up; the sizer hides and the search slot takes over.
    const overlay = page.locator('.terminal-dashboard-dedicated');
    await expect(overlay).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#terminal-dashboard-sizer')).toBeHidden();
    const slot = page.locator('#terminal-dashboard-search-slot');
    await expect(slot).toBeVisible();

    // The search widget is mounted inside the slot. Open it + search.
    const searchBox = slot.locator('.terminal-search-box');
    await expect(searchBox).toBeVisible();
    await searchBox.locator('.terminal-search-toggle').click();
    await expect(searchBox).toHaveClass(/is-open/);
    const input = searchBox.locator('.terminal-search-input');
    await expect(input).toBeFocused();

    // Wait for the history replay to populate the dedicated xterm, then
    // assert the same three-match count we saw in the drawer.
    await expect(overlay.locator('.xterm-screen')).toContainText('banana', { timeout: 8000 });
    await input.fill('apple');
    await expect(searchBox.locator('.terminal-search-count')).toHaveText('1/3', { timeout: 3000 });

    // Exit the dedicated view via the Back button. Slot should hide, sizer
    // should come back, and the dashboard grid is visible again.
    await overlay.locator('.terminal-dashboard-dedicated-back').click();
    await expect(overlay).toHaveCount(0, { timeout: 3000 });
    await expect(slot).toBeHidden();
    await expect(page.locator('#terminal-dashboard-sizer')).toBeVisible();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);
  });

  // 4. HS-7427 — recent-query history: ArrowUp walks back through three
  // distinct submitted queries in MRU order; ArrowDown returns to the draft.
  // Validates the per-xterm WeakMap, MRU-at-tail ordering, and draft
  // preservation against a real PTY + xterm + SearchAddon stack.
  test('drawer: ArrowUp walks back through three submitted queries (HS-7427)', async ({ page }) => {
    await openDrawerAndWaitForFruits(page);

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
  test('drawer: regex toggle on `app.e` matches three lines (HS-7426)', async ({ page }) => {
    await openDrawerAndWaitForFruits(page);

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

  // 6. Regression: while in grid view (no dedicated view up) the header
  // search slot must stay hidden; the sizer is the grid-view control.
  test('grid view keeps the header search slot hidden (sizer visible instead)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);

    await expect(page.locator('#terminal-dashboard-sizer')).toBeVisible();
    await expect(page.locator('#terminal-dashboard-search-slot')).toBeHidden();
  });
});
