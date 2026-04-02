import { expect, test } from '@playwright/test';

// Smoke tests for upgrading hotsheet from the stable release to a beta.
// Prerequisites (handled by CI):
//   1. hotsheet@latest (stable) was installed, started, and seeded with data via API:
//      - 3 tickets created: "Upgrade ticket 1" (started), "Upgrade ticket 2" (completed), "Upgrade ticket 3" (not_started, up_next, with a note)
//   2. Server was stopped
//   3. hotsheet@{beta} was installed over the top
//   4. Server was restarted with the same --data-dir
//   5. Server is running on $SMOKE_PORT

test.describe('Upgrade install smoke test', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 15000 });
  });

  test('page loads after upgrade', async ({ page }) => {
    await expect(page.locator('.draft-input')).toBeVisible();
    await expect(page.locator('.sidebar-item[data-view="all"]')).toBeVisible();
  });

  test('pre-existing tickets survived the upgrade', async ({ page }) => {
    // Verify all 3 seeded tickets exist
    const statsRes = await page.request.get('/api/stats');
    expect(statsRes.ok()).toBe(true);
    const stats = await statsRes.json();
    expect(stats.total).toBeGreaterThanOrEqual(3);
  });

  test('ticket statuses preserved after upgrade', async ({ page }) => {
    const res = await page.request.get('/api/tickets?sort_by=created&sort_dir=asc');
    expect(res.ok()).toBe(true);
    const tickets = await res.json();

    // Find our seeded tickets by title
    const t1 = tickets.find((t: { title: string }) => t.title === 'Upgrade ticket 1');
    const t2 = tickets.find((t: { title: string }) => t.title === 'Upgrade ticket 2');
    const t3 = tickets.find((t: { title: string }) => t.title === 'Upgrade ticket 3');

    expect(t1).toBeDefined();
    expect(t2).toBeDefined();
    expect(t3).toBeDefined();

    expect(t1.status).toBe('started');
    expect(t2.status).toBe('completed');
    expect(t3.status).toBe('not_started');
    expect(t3.up_next).toBe(true);
  });

  test('notes preserved after upgrade', async ({ page }) => {
    const res = await page.request.get('/api/tickets?sort_by=created&sort_dir=asc');
    const tickets = await res.json();
    const t3 = tickets.find((t: { title: string }) => t.title === 'Upgrade ticket 3');
    expect(t3).toBeDefined();

    // Ticket 3 should have a note
    const detailRes = await page.request.get(`/api/tickets/${t3.id}`);
    const detail = await detailRes.json();
    expect(detail.notes).toContain('Pre-upgrade note');
  });

  test('can create new tickets after upgrade', async ({ page }) => {
    const draft = page.locator('.draft-input');
    await draft.fill('Post-upgrade ticket');
    await draft.press('Enter');
    await expect(page.locator('.ticket-title-input[value="Post-upgrade ticket"]')).toBeVisible({ timeout: 5000 });
  });

  test('search works after upgrade', async ({ page }) => {
    const searchInput = page.locator('#search-input');
    await searchInput.fill('Upgrade ticket 1');
    await page.waitForTimeout(300);
    await expect(page.locator('.ticket-title-input[value="Upgrade ticket 1"]')).toBeVisible({ timeout: 5000 });
  });
});
