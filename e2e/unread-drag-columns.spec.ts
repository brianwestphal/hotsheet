/**
 * HS-5810: Verify that dragging tickets between columns does not mark them as unread.
 * Tests the exact user scenario: mark tickets as read, then drag to a new column.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Unread: column drag does not mark as unread (HS-5810)', () => {
  let headers: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test('mark as read then change status via batch keeps tickets read', async ({ request }) => {
    const suffix = Date.now();
    const titles = [`Drag A ${suffix}`, `Drag B ${suffix}`];
    const ids: number[] = [];

    // Create tickets
    for (const title of titles) {
      const res = await request.post('/api/tickets', { headers, data: { title } });
      const ticket = await res.json() as { id: number };
      ids.push(ticket.id);
    }

    // Mark both as read (simulate "Mark as Read" from context menu)
    await request.post('/api/tickets/batch', {
      headers: { ...headers, 'X-Hotsheet-User-Action': 'true' },
      data: { ids, action: 'mark_read' },
    });

    // Verify they're read
    for (const id of ids) {
      const res = await request.get(`/api/tickets/${id}`, { headers });
      const t = await res.json() as { last_read_at: string | null };
      expect(t.last_read_at).not.toBeNull();
    }

    // Now change status (simulating a column drag with the User-Action header)
    await request.post('/api/tickets/batch', {
      headers: { ...headers, 'X-Hotsheet-User-Action': 'true' },
      data: { ids, action: 'status', value: 'started' },
    });

    // Both tickets should still be read (not unread)
    for (const id of ids) {
      const res = await request.get(`/api/tickets/${id}`, { headers });
      const t = await res.json() as { updated_at: string; last_read_at: string | null };
      expect(t.last_read_at).not.toBeNull();
      // last_read_at should be >= updated_at
      expect(t.updated_at <= t.last_read_at!).toBe(true);
    }
  });

  test('mark as read then change status WITHOUT User-Action header marks as unread', async ({ request }) => {
    const suffix = Date.now();
    const title = `API drag ${suffix}`;
    const res = await request.post('/api/tickets', { headers, data: { title } });
    const ticket = await res.json() as { id: number };

    // Mark as read
    await request.patch(`/api/tickets/${ticket.id}`, { headers, data: { last_read_at: new Date().toISOString() } });

    // Change status WITHOUT User-Action header (simulating AI/API change)
    await request.post('/api/tickets/batch', {
      headers, // no X-Hotsheet-User-Action
      data: { ids: [ticket.id], action: 'status', value: 'started' },
    });

    // Ticket should now be unread
    const ticketRes = await request.get(`/api/tickets/${ticket.id}`, { headers });
    const updated = await ticketRes.json() as { updated_at: string; last_read_at: string | null };
    expect(updated.last_read_at).not.toBeNull();
    expect(updated.updated_at > updated.last_read_at!).toBe(true);
  });

  test('full browser flow: read tickets, batch status change, verify no blue dot', async ({ page, request }) => {
    const suffix = Date.now();
    const titles = [`Browser drag A ${suffix}`, `Browser drag B ${suffix}`];
    const ids: number[] = [];

    for (const title of titles) {
      const res = await request.post('/api/tickets', { headers, data: { title } });
      const ticket = await res.json() as { id: number };
      ids.push(ticket.id);
    }

    // Mark both as read via API
    const now = new Date().toISOString();
    for (const id of ids) {
      await request.patch(`/api/tickets/${id}`, { headers, data: { last_read_at: now } });
    }

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Select both tickets
    const rowA = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${titles[0]}"]`) }).first();
    const rowB = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${titles[1]}"]`) }).first();
    await rowA.locator('.ticket-number').click();
    await rowB.locator('.ticket-number').click({ modifiers: ['Meta'] });
    await page.waitForTimeout(200);

    // Neither should have a blue dot before the change
    await expect(rowA.locator('.ticket-unread-dot')).toBeHidden();
    await expect(rowB.locator('.ticket-unread-dot')).toBeHidden();

    // Right-click → Status → Started (simulating what happens when you drag between columns)
    await rowA.locator('.ticket-number').click({ button: 'right' });
    await page.waitForTimeout(200);
    const statusSubmenu = page.locator('.context-menu-item.has-submenu').filter({ hasText: 'Status' });
    await statusSubmenu.hover();
    const submenuContent = statusSubmenu.locator('.context-submenu');
    await expect(submenuContent).toBeVisible({ timeout: 3000 });
    await submenuContent.locator('.context-menu-item .context-menu-label').filter({ hasText: /^Started$/ }).click();
    await page.waitForTimeout(1000); // Wait for API + loadTickets to complete

    // Neither ticket should show a blue dot after the status change
    const rowA2 = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${titles[0]}"]`) }).first();
    const rowB2 = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${titles[1]}"]`) }).first();
    await expect(rowA2.locator('.ticket-unread-dot')).toBeHidden({ timeout: 3000 });
    await expect(rowB2.locator('.ticket-unread-dot')).toBeHidden({ timeout: 3000 });
  });
});
