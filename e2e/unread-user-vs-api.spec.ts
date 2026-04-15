/**
 * HS-5776: Verify that user-initiated changes (via UI) don't mark tickets as unread,
 * while API/AI changes (without X-Hotsheet-User-Action header) DO mark them as unread.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Unread: user vs API changes (HS-5776)', () => {
  let headers: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('API change (no User-Action header) marks ticket as unread', async ({ request }) => {
    const suffix = Date.now();
    const title = `API change ${suffix}`;
    const res = await request.post('/api/tickets', { headers, data: { title } });
    const ticket = await res.json() as { id: number };

    // Mark as read first
    await request.patch(`/api/tickets/${ticket.id}`, { headers, data: { last_read_at: new Date().toISOString() } });

    // Make an API change WITHOUT the User-Action header (simulating AI/external change)
    await request.patch(`/api/tickets/${ticket.id}`, { headers, data: { details: 'Changed by AI' } });

    // Ticket should now be unread (updated_at > last_read_at)
    const ticketRes = await request.get(`/api/tickets/${ticket.id}`, { headers });
    const updated = await ticketRes.json() as { updated_at: string; last_read_at: string | null };
    expect(updated.last_read_at).not.toBeNull();
    expect(updated.updated_at > updated.last_read_at!).toBe(true);
  });

  test('UI change (with User-Action header) keeps ticket as read', async ({ request }) => {
    const suffix = Date.now();
    const title = `UI change ${suffix}`;
    const res = await request.post('/api/tickets', { headers, data: { title } });
    const ticket = await res.json() as { id: number };

    // Mark as read first
    await request.patch(`/api/tickets/${ticket.id}`, { headers, data: { last_read_at: new Date().toISOString() } });

    // Make a change WITH the User-Action header (simulating UI change)
    await request.patch(`/api/tickets/${ticket.id}`, {
      headers: { ...headers, 'X-Hotsheet-User-Action': 'true' },
      data: { details: 'Changed by user' },
    });

    // Ticket should still be read (last_read_at bumped alongside updated_at)
    const ticketRes = await request.get(`/api/tickets/${ticket.id}`, { headers });
    const updated = await ticketRes.json() as { updated_at: string; last_read_at: string | null };
    expect(updated.last_read_at).not.toBeNull();
    // last_read_at should be >= updated_at (both set to NOW())
    expect(updated.updated_at <= updated.last_read_at!).toBe(true);
  });

  test('batch status change via UI does not mark tickets as unread', async ({ page, request }) => {
    const suffix = Date.now();
    const title = `Batch UI ${suffix}`;
    const res = await request.post('/api/tickets', { headers, data: { title } });
    const ticket = await res.json() as { id: number };

    // Mark as read
    await request.patch(`/api/tickets/${ticket.id}`, { headers, data: { last_read_at: new Date().toISOString() } });

    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Change status via the UI (click status button)
    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) }).first();
    const statusBtn = row.locator('.ticket-status-btn');
    await statusBtn.click();
    await expect(statusBtn).toHaveAttribute('title', 'started', { timeout: 3000 });

    // Wait for the API call to complete
    await page.waitForTimeout(500);

    // Ticket should still be read (no blue dot)
    const ticketRes = await request.get(`/api/tickets/${ticket.id}`, { headers });
    const updated = await ticketRes.json() as { updated_at: string; last_read_at: string | null };
    expect(updated.last_read_at).not.toBeNull();
    expect(updated.updated_at <= updated.last_read_at!).toBe(true);
  });

  test('multi-ticket batch status change via context menu keeps tickets read', async ({ page, request }) => {
    const suffix = Date.now();
    const titleA = `Multi batch A ${suffix}`;
    const titleB = `Multi batch B ${suffix}`;
    const resA = await request.post('/api/tickets', { headers, data: { title: titleA } });
    const ticketA = await resA.json() as { id: number };
    const resB = await request.post('/api/tickets', { headers, data: { title: titleB } });
    const ticketB = await resB.json() as { id: number };

    // Mark both as read
    const now = new Date().toISOString();
    await request.patch(`/api/tickets/${ticketA.id}`, { headers, data: { last_read_at: now } });
    await request.patch(`/api/tickets/${ticketB.id}`, { headers, data: { last_read_at: now } });

    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Select both tickets
    const rowA = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${titleA}"]`) }).first();
    const rowB = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${titleB}"]`) }).first();
    await rowA.locator('.ticket-number').click();
    await rowB.locator('.ticket-number').click({ modifiers: ['Meta'] });
    await page.waitForTimeout(200);

    // Right-click → Status → Started
    await rowA.locator('.ticket-number').click({ button: 'right' });
    await page.waitForTimeout(200);
    const statusSubmenu = page.locator('.context-menu-item.has-submenu').filter({ hasText: 'Status' });
    await statusSubmenu.hover();
    const statusSubmenuContent = statusSubmenu.locator('.context-submenu');
    await expect(statusSubmenuContent).toBeVisible({ timeout: 3000 });
    await statusSubmenuContent.locator('.context-menu-item .context-menu-label').filter({ hasText: /^Started$/ }).click();
    await page.waitForTimeout(500);

    // Both tickets should still be read
    for (const id of [ticketA.id, ticketB.id]) {
      const ticketRes = await request.get(`/api/tickets/${id}`, { headers });
      const updated = await ticketRes.json() as { updated_at: string; last_read_at: string | null };
      expect(updated.last_read_at).not.toBeNull();
      expect(updated.updated_at <= updated.last_read_at!).toBe(true);
    }
  });

  test('editing title via detail panel does not mark ticket as unread', async ({ page, request }) => {
    const suffix = Date.now();
    const title = `Title edit ${suffix}`;
    const res = await request.post('/api/tickets', { headers, data: { title } });
    const ticket = await res.json() as { id: number };

    // Mark as read
    await request.patch(`/api/tickets/${ticket.id}`, { headers, data: { last_read_at: new Date().toISOString() } });

    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Open detail panel
    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) }).first();
    await row.locator('.ticket-number').click();
    await expect(page.locator('#detail-header')).toBeVisible({ timeout: 3000 });

    // Edit title
    await page.locator('#detail-title').fill(`${title} edited`);
    await page.waitForTimeout(1000); // Wait for debounced save

    // Ticket should still be read
    const ticketRes = await request.get(`/api/tickets/${ticket.id}`, { headers });
    const updated = await ticketRes.json() as { updated_at: string; last_read_at: string | null };
    expect(updated.last_read_at).not.toBeNull();
    expect(updated.updated_at <= updated.last_read_at!).toBe(true);
  });
});
