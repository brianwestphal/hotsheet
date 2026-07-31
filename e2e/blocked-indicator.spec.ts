/**
 * HS-9487 — the blocked / feedback-needed row indicators (docs/116 §116.3) must
 * be visible in BOTH layouts.
 *
 * The bug these pin: HS-9336 wired the borders into the list row only, so on the
 * column board a blocked ticket was indistinguishable from an unblocked one.
 *
 * These assert the COMPUTED `border-left-color`, not the class name — the class
 * landing without a matching CSS rule is exactly the half-fix that would still
 * leave the user with nothing to see.
 */
import type { Locator, Page } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

/** `--blocked: #4b5563` (styles.scss) — the dark-gray blocked accent. */
const BLOCKED_RGB = 'rgb(75, 85, 99)';
/** `--star: #eab308` — the gold up-next accent, for the precedence check. */
const STAR_RGB = 'rgb(234, 179, 8)';

async function createTicket(page: Page, title: string) {
  const draft = page.locator('.draft-input');
  await draft.fill(title);
  await draft.press('Enter');
  await expect(page.locator(`.ticket-row[data-id] .ticket-title-input[value="${title}"]`)).toBeVisible({ timeout: 5000 });
}

async function openDetail(page: Page, title: string) {
  const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) });
  await row.locator('.ticket-number').click();
  await expect(page.locator('#detail-header')).toBeVisible({ timeout: 5000 });
}

/**
 * Set the blocked reason through the detail-panel editor (the real user flow),
 * then poll the API until the debounced auto-save has round-tripped — a fixed
 * timeout races the save under load (the HS-9352 flake).
 */
async function setBlockedReason(page: Page, title: string, reason: string) {
  await page.locator('#detail-blocked-reason').fill(reason);
  await expect.poll(async () => {
    const res = await page.request.get('/api/tickets?status=active');
    const tickets = await res.json() as { title: string; blocked_reason: string | null }[];
    return tickets.find(t => t.title === title)?.blocked_reason ?? '';
  }, { timeout: 8000 }).toBe(reason);
}

function borderLeftColor(locator: Locator) {
  return locator.evaluate(el => getComputedStyle(el).borderLeftColor);
}

test.describe('Blocked-reason row indicator (HS-9487)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('list row shows the blocked border, and clearing the reason removes it', async ({ page }) => {
    await createTicket(page, 'Blocked list ticket');
    await openDetail(page, 'Blocked list ticket');

    const row = page.locator('.ticket-row[data-id]').filter({
      has: page.locator('.ticket-title-input[value="Blocked list ticket"]'),
    });

    // Baseline: no reason, no accent.
    expect(await borderLeftColor(row)).not.toBe(BLOCKED_RGB);

    await setBlockedReason(page, 'Blocked list ticket', 'Waiting on a decision about API spend.');
    await expect.poll(() => borderLeftColor(row), { timeout: 8000 }).toBe(BLOCKED_RGB);

    // Clearing it puts the row back to unmarked.
    await page.locator('#detail-blocked-reason').fill('');
    await expect.poll(() => borderLeftColor(row), { timeout: 8000 }).not.toBe(BLOCKED_RGB);
  });

  test('column-view card shows the blocked border too', async ({ page }) => {
    await createTicket(page, 'Blocked column ticket');
    await openDetail(page, 'Blocked column ticket');
    await setBlockedReason(page, 'Blocked column ticket', 'Waiting on HS-1234 to land.');

    // Switch to the board — this is the layout that had NO indicator at all.
    await page.locator('.layout-btn[data-layout="columns"]').click();
    await expect(page.locator('#ticket-list')).toHaveClass(/ticket-list-columns/, { timeout: 5000 });

    const card = page.locator('.column-card[data-id]').filter({ hasText: 'Blocked column ticket' });
    await expect(card).toBeVisible({ timeout: 5000 });
    await expect.poll(() => borderLeftColor(card), { timeout: 8000 }).toBe(BLOCKED_RGB);
  });

  test('blocked wins over up-next on a ticket that is both', async ({ page }) => {
    await createTicket(page, 'Blocked and starred ticket');

    const row = page.locator('.ticket-row[data-id]').filter({
      has: page.locator('.ticket-title-input[value="Blocked and starred ticket"]'),
    });

    // Star it first — gold accent.
    await row.locator('.ticket-star').click();
    await expect.poll(() => borderLeftColor(row), { timeout: 8000 }).toBe(STAR_RGB);

    // Adding a blocked reason takes the row over: docs/116 §116.3 precedence.
    await openDetail(page, 'Blocked and starred ticket');
    await setBlockedReason(page, 'Blocked and starred ticket', 'Waiting on a manual step.');
    await expect.poll(() => borderLeftColor(row), { timeout: 8000 }).toBe(BLOCKED_RGB);
  });
});
