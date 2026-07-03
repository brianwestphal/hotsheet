/**
 * HS-9192 — Phase 4 e2e for the active-device multi-client terminal model
 * (docs/109-multi-client-terminals.md §109.7). Two browser contexts = two
 * devices (distinct `localStorage` deviceIds) against ONE server + project:
 *
 *  1. The non-active device shows the "take control" placeholder for the
 *     terminal while the other device holds the active lease.
 *  2. Clicking "take control" on the placeholder claims active (immediate
 *     handoff) → the flip: the clicker goes live, the previous holder goes to
 *     the placeholder (the observable proof the superseded device stops driving
 *     — the exact PTY-size handoff is pinned server-side by
 *     `src/terminals/websocket.test.ts` "hands off resize control on a device
 *     switch", which can't be asserted cleanly here since `/api/terminal/list`
 *     exposes no PTY dims).
 *  3. A sustained (debounced) interaction in the non-active device — a keypress,
 *     not the button — also claims active and flips.
 *
 * The drawer + default terminal are auto-opened via file-settings
 * (`drawer_open` + `drawer_active_tab: 'terminal:default'`) so a device's pane
 * mounts WITHOUT a click — a click is itself an "interaction" that would claim
 * active, so the non-active device is loaded click-free to keep it non-active.
 * The active device is made the explicit holder by a deliberate interaction,
 * done promptly (well inside the 5 s renew interval) so its heartbeat can't race
 * the handoff.
 */
import type { APIRequestContext, Browser, Page } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

const PTY_READY_MS = 15_000;

// The fixture's auto-suppressions (upgrade nudge / DOM renderer / AI nudge) bind
// only to the primary `page`; a manually-created second context needs them too.
const SECOND_CONTEXT_INIT = `
  try { window.localStorage.setItem('hotsheet_upgrade_nudge_last_shown', String(Number.MAX_SAFE_INTEGER)); } catch {}
  try { window.__HOTSHEET_DISABLE_WEBGL__ = true; } catch {}
  try { window.__HOTSHEET_DISABLE_AI_NUDGE__ = true; } catch {}
`;

const PANE = '.drawer-terminal-pane[data-drawer-panel="terminal:default"]';

let headers: Record<string, string> = {};

async function activeHolder(request: APIRequestContext): Promise<string | null> {
  const res = await request.get('/api/devices/active', { headers });
  if (!res.ok()) return null;
  const body = await res.json() as { active: { deviceId: string } | null };
  return body.active?.deviceId ?? null;
}

function deviceIdOf(page: Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem('hotsheet:deviceId'));
}

/**
 * Make `page`'s device the active holder via a real (debounced) interaction and
 * wait until the server confirms it. Claiming (last-claim-wins) supersedes any
 * ghost holder left by a prior test whose 15 s lease hasn't lapsed — so each
 * test starts from a deterministic "this device is active" state regardless of
 * cross-test lease leakage. Returns the device id.
 */
async function claimActive(page: Page, request: APIRequestContext): Promise<string> {
  const id = await deviceIdOf(page);
  // A single click inside the app is a "sustained interaction" → debounced claim.
  await page.locator('.draft-input').click();
  await expect.poll(() => activeHolder(request), { timeout: 6_000 }).toBe(id);
  return id ?? '';
}

/** Open a fresh device (a new browser context = fresh localStorage → a distinct
 *  synthetic deviceId) with the app loaded + drawer/terminal auto-opened. */
async function openSecondDevice(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(SECOND_CONTEXT_INIT);
  await page.goto('/');
  await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10_000 });
  return { page, close: () => context.close() };
}

test.describe('Multi-client terminals — active-device flow (HS-9192)', () => {
  test.beforeAll(async ({ request }) => {
    const projects = await (await request.get('/api/projects')).json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ request }) => {
    // Reset to a single long-lived default terminal with the drawer auto-open +
    // that terminal as the active tab, so each device's pane mounts on load
    // WITHOUT a click (a click would claim active). Any lingering active-device
    // lease from a prior test lapses via the 15 s TTL; each test re-establishes
    // its holder explicitly.
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'true',
        drawer_active_tab: 'terminal:default',
        terminals: [{ id: 'default', name: 'Default', command: 'sleep 100000', lazy: true }],
      },
    });
  });

  test('non-active device shows the take-control placeholder; take-control flips both (HS-9192)', async ({ page, browser, request }) => {
    // --- Device A (primary page) becomes the active holder ------------------
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10_000 });
    const deviceA = await claimActive(page, request); // supersedes any ghost holder
    const paneA = page.locator(PANE);
    await expect(paneA.locator('.xterm-rows')).toBeVisible({ timeout: PTY_READY_MS }); // A is live (the holder)

    // --- Device B (second context) is non-active → placeholder -------------
    const b = await openSecondDevice(browser);
    const paneB = b.page.locator(PANE);
    // B mounts live briefly then flips to the placeholder once its resync learns
    // A holds the lease. B never interacts, so it stays non-active.
    await expect(paneB.locator('.terminal-checkout-placeholder-inactive')).toBeVisible({ timeout: 10_000 });
    await expect(paneB.locator('.terminal-checkout-placeholder-text')).toHaveText('Active on another device');
    await expect(paneB.locator('.terminal-checkout-take-control')).toBeVisible();
    const deviceB = await deviceIdOf(b.page);
    expect(deviceB).not.toBeNull();
    expect(deviceB).not.toBe(deviceA);

    // --- B clicks "take control" → immediate handoff -----------------------
    await paneB.locator('.terminal-checkout-take-control').click();
    await expect.poll(() => activeHolder(request), { timeout: 6_000 }).toBe(deviceB);

    // B is now live; A flips to the placeholder (it stopped driving the PTY).
    await expect(paneB.locator('.xterm-rows')).toBeVisible({ timeout: PTY_READY_MS });
    await expect(paneB.locator('.terminal-checkout-placeholder-inactive')).toHaveCount(0);
    await expect(paneA.locator('.terminal-checkout-placeholder-inactive')).toBeVisible({ timeout: 10_000 });
    await expect(paneA.locator('.xterm-rows')).toHaveCount(0);

    await b.close();
  });

  test('sustained interaction (a keypress) in the non-active device claims active (HS-9192)', async ({ page, browser, request }) => {
    // Device A holds the lease (same setup as above).
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10_000 });
    await claimActive(page, request); // A becomes the holder (supersedes any ghost)
    const paneA = page.locator(PANE);
    await expect(paneA.locator('.xterm-rows')).toBeVisible({ timeout: PTY_READY_MS });

    // Device B loads non-active (placeholder).
    const b = await openSecondDevice(browser);
    const paneB = b.page.locator(PANE);
    await expect(paneB.locator('.terminal-checkout-placeholder-inactive')).toBeVisible({ timeout: 10_000 });
    const deviceB = await deviceIdOf(b.page);

    // A generic sustained interaction (NOT the take-control button): focus the
    // draft input and type. The debounced (750ms) claim fires → B claims active.
    await b.page.locator('.draft-input').click();
    await b.page.keyboard.type('hello');
    await expect.poll(() => activeHolder(request), { timeout: 6_000 }).toBe(deviceB);

    // B flips live, A flips to the placeholder.
    await expect(paneB.locator('.xterm-rows')).toBeVisible({ timeout: PTY_READY_MS });
    await expect(paneA.locator('.terminal-checkout-placeholder-inactive')).toBeVisible({ timeout: 10_000 });

    await b.close();
  });
});
