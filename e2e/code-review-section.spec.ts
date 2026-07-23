/**
 * HS-9393 (docs/122) — the detail-panel "Code Review" section's aggregate
 * Open-in-Glassbox button, through the real browser UI. The commit-discovery +
 * review endpoints are ROUTE-MOCKED (the e2e project root isn't a git repo, and
 * launching real Glassbox is out of scope) — the server-side discovery logic has
 * its own real-git unit tests (`ticketCommits.test.ts`). Routes are installed
 * BEFORE navigation so the new ticket's initial detail auto-open sees them.
 */
import { expect, test } from './coverage-fixture.js';

// The first subject is deliberately long: HS-9401 asserts the chooser stays inside
// the detail panel's width (pre-fix, nowrap option rows pushed it past the edge).
const LONG_SUBJECT = 'HS-E2E: newer fix with a deliberately long subject line that used to overflow the detail panel horizontally before the two-line clamp landed';
const GROUPS = {
  groups: [
    { from: 'ccc^', to: 'ddd', count: 1, subjects: [LONG_SUBJECT], earliestDate: '2026-07-23T10:00:00Z', latestDate: '2026-07-23T10:00:00Z' },
    { from: 'aaa^', to: 'bbb', count: 2, subjects: ['HS-E2E: part two', 'HS-E2E: part one'], earliestDate: '2026-07-22T10:00:00Z', latestDate: '2026-07-22T11:00:00Z' },
  ],
  span: { from: 'aaa^', to: 'ddd', unrelatedCount: 2 },
  dirty: false,
  ticketStatus: 'completed',
};

test.describe('Code Review section (HS-9393)', () => {
  test('interleaved groups render the chooser; picking an option posts the range', async ({ page }) => {
    const reviewPosts: unknown[] = [];
    await page.route('**/api/tickets/*/commits*', (route) => route.fulfill({ json: GROUPS }));
    await page.route('**/api/glassbox/review', async (route) => {
      reviewPosts.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true } });
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('.draft-input').fill('Code review e2e ticket');
    await page.locator('.draft-input').press('Enter');
    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Code review e2e ticket"]') });
    await expect(row).toBeVisible({ timeout: 5000 });
    await row.locator('.ticket-number').click();

    const section = page.locator('#detail-review-proof');
    await expect(section.locator('.review-proof-label')).toHaveText('Code Review', { timeout: 5000 });

    const btn = section.locator('.code-review-aggregate-btn');
    await expect(btn).toContainText('Open in Glassbox');
    // HS-9400 — assert COMPUTED visibility (not the hidden attribute): the menu's
    // `display: flex` used to beat the UA's `[hidden]` rule, leaving it permanently
    // open so the button toggle visibly did nothing. The unit test's attribute
    // assertions can't catch that CSS-cascade class of bug; this can.
    const menu = section.locator('.code-review-chooser');
    await expect(menu).toBeHidden();
    await btn.click();
    await expect(menu).toBeVisible();
    await btn.click(); // toggles closed…
    await expect(menu).toBeHidden();
    await btn.click(); // …and open again
    await expect(menu).toBeVisible();
    const options = menu.locator('.code-review-chooser-option');
    await expect(options).toHaveCount(3); // 2 groups + the span option
    await expect(options.nth(2)).toContainText('includes 2 unrelated commits');

    // HS-9401 — the long-subject row must stay INSIDE the detail panel: pre-fix,
    // nowrap option labels widened the chooser past the panel's right edge.
    const panelBox = (await page.locator('#detail-panel').boundingBox())!;
    const menuBox = (await menu.boundingBox())!;
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);

    // Pick the two-commit group via its Review button (HS-9401: row click expands;
    // the button launches) → the exact range posts to /glassbox/review. (The
    // menu's collapse-after-pick is asserted deterministically in the unit test;
    // here a background detail reload can re-render the section, so we only
    // assert the review request landed.)
    await options.nth(1).locator('.code-review-option-review').click();
    await expect.poll(() => reviewPosts.length, { timeout: 5000 }).toBe(1);
    expect(reviewPosts[0]).toEqual({ mode: 'range', from: 'aaa^', to: 'bbb' });
  });

  test('HS-9402 — switching tickets (incl. revisits) repaints the section for the selected ticket', async ({ page }) => {
    // Per-ticket mock: every ticket gets two groups whose subjects embed the
    // requested ticket number, so the chooser's option text identifies WHOSE
    // section is currently painted.
    await page.route('**/api/tickets/*/commits*', (route) => {
      const m = /tickets\/([^/]+)\/commits/.exec(route.request().url());
      const num = m ? decodeURIComponent(m[1]) : '?';
      return route.fulfill({ json: {
        groups: [
          { from: 'a^', to: 'b', count: 1, subjects: [`${num}: first group`], earliestDate: '2026-07-22T10:00:00Z', latestDate: '2026-07-22T10:00:00Z' },
          { from: 'c^', to: 'd', count: 1, subjects: [`${num}: second group`], earliestDate: '2026-07-23T10:00:00Z', latestDate: '2026-07-23T10:00:00Z' },
        ],
        span: null, dirty: false, ticketStatus: 'completed',
      } });
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('.draft-input').fill('Switch ticket A');
    await page.locator('.draft-input').press('Enter');
    const rowA = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Switch ticket A"]') });
    await expect(rowA).toBeVisible({ timeout: 5000 });
    const numA = (await rowA.locator('.ticket-number').textContent())?.trim() ?? '';
    await page.locator('.draft-input').fill('Switch ticket B');
    await page.locator('.draft-input').press('Enter');
    const rowB = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Switch ticket B"]') });
    await expect(rowB).toBeVisible({ timeout: 5000 });
    const numB = (await rowB.locator('.ticket-number').textContent())?.trim() ?? '';

    const firstOption = page.locator('#detail-review-proof .code-review-chooser-option').first();
    // A → B is the plain-switch path; B → A → B revisits hit the per-ticket cache
    // (the HS-9402 stale-content path: an unchanged cached ticket + a non-empty
    // container holding the OTHER ticket's section used to skip the repaint).
    await rowA.locator('.ticket-number').click();
    await expect(firstOption).toContainText(`${numA}: first group`, { timeout: 5000 });
    await rowB.locator('.ticket-number').click();
    await expect(firstOption).toContainText(`${numB}: first group`, { timeout: 5000 });
    await rowA.locator('.ticket-number').click();
    await expect(firstOption).toContainText(`${numA}: first group`, { timeout: 5000 });
    await rowB.locator('.ticket-number').click();
    await expect(firstOption).toContainText(`${numB}: first group`, { timeout: 5000 });
  });

  test('a single linear group reviews directly via range mode', async ({ page }) => {
    const reviewPosts: unknown[] = [];
    await page.route('**/api/tickets/*/commits*', (route) => route.fulfill({
      json: { groups: [{ from: 'e^', to: 'f', count: 3, subjects: ['HS-E2E: c', 'HS-E2E: b', 'HS-E2E: a'], earliestDate: '2026-07-22T10:00:00Z', latestDate: '2026-07-22T12:00:00Z' }], span: null, dirty: false, ticketStatus: 'completed' },
    }));
    await page.route('**/api/glassbox/review', async (route) => {
      reviewPosts.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true } });
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('.draft-input').fill('Single group e2e ticket');
    await page.locator('.draft-input').press('Enter');
    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Single group e2e ticket"]') });
    await expect(row).toBeVisible({ timeout: 5000 });
    await row.locator('.ticket-number').click();

    const btn = page.locator('#detail-review-proof .code-review-aggregate-btn');
    await expect(btn).toHaveText('Open in Glassbox', { timeout: 5000 }); // no chooser chevron
    await btn.click();
    await expect.poll(() => reviewPosts.length, { timeout: 5000 }).toBe(1);
    expect(reviewPosts[0]).toEqual({ mode: 'range', from: 'e^', to: 'f' });
  });
});
