/**
 * HS-5648: Unread ticket indicators — blue dot, mark as read/unread.
 * Tests the complete unread indicator lifecycle through real browser interactions.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Unread ticket indicators (HS-5648)', () => {
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

  test('ticket with last_read_at older than updated_at shows blue dot in list view', async ({ page, request }) => {
    const suffix = Date.now();
    const title = `Unread dot ${suffix}`;
    const res = await request.post('/api/tickets', { headers, data: { title } });
    const ticket = await res.json() as { id: number };

    // Set last_read_at to old date, then update to make updated_at newer
    await request.patch(`/api/tickets/${ticket.id}`, { headers, data: { last_read_at: '2020-01-01T00:00:00Z' } });
    await request.patch(`/api/tickets/${ticket.id}`, { headers, data: { details: 'Updated content' } });

    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) }).first();
    await expect(row.locator('.ticket-unread-dot')).toBeVisible({ timeout: 5000 });
  });

  test('UI-created ticket does NOT show blue dot (user actions start as read)', async ({ page, request }) => {
    const suffix = Date.now();
    const title = `No dot ${suffix}`;
    // Simulate UI creation with User-Action header — should NOT set epoch last_read_at
    await request.post('/api/tickets', { headers: { ...headers, 'X-Hotsheet-User-Action': 'true' }, data: { title } });

    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) }).first();
    await expect(row.locator('.ticket-unread-dot')).toBeHidden();
  });

  test('opening detail panel auto-marks ticket as read', async ({ page, request }) => {
    const suffix = Date.now();
    const title = `Auto read ${suffix}`;
    const res = await request.post('/api/tickets', { headers, data: { title } });
    const ticket = await res.json() as { id: number };

    // Make it unread
    await request.patch(`/api/tickets/${ticket.id}`, { headers, data: { last_read_at: '2020-01-01T00:00:00Z' } });
    await request.patch(`/api/tickets/${ticket.id}`, { headers, data: { details: 'Some update' } });

    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) }).first();
    await expect(row.locator('.ticket-unread-dot')).toBeVisible({ timeout: 5000 });

    // Click to open detail
    await row.locator('.ticket-number').click();
    await expect(page.locator('#detail-header')).toBeVisible({ timeout: 3000 });
    await page.waitForTimeout(500);

    // Verify via API that last_read_at was updated
    const ticketRes = await request.get(`/api/tickets/${ticket.id}`, { headers });
    const updated = await ticketRes.json() as { last_read_at: string | null };
    expect(updated.last_read_at).not.toBeNull();
    // last_read_at should be recent (within the last 5 seconds)
    const readTime = new Date(updated.last_read_at!).getTime();
    expect(Date.now() - readTime).toBeLessThan(5000);
  });

  test('context menu Mark as Unread sets last_read_at to null via API', async ({ page, request }) => {
    const suffix = Date.now();
    const title = `Ctx unread ${suffix}`;
    const res = await request.post('/api/tickets', { headers, data: { title } });
    const ticket = await res.json() as { id: number };

    // Mark as read first
    await request.patch(`/api/tickets/${ticket.id}`, { headers, data: { last_read_at: new Date().toISOString() } });

    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) }).first();

    // Select and right-click → Mark as Unread
    await row.locator('.ticket-number').click();
    await row.locator('.ticket-number').click({ button: 'right' });
    await page.waitForTimeout(200);
    await page.locator('.context-menu-item').filter({ hasText: 'Mark as Unread' }).click();
    await page.waitForTimeout(500);

    // Verify via API
    const ticketRes = await request.get(`/api/tickets/${ticket.id}`, { headers });
    const updated = await ticketRes.json() as { last_read_at: string | null };
    // Mark as unread uses epoch date (not null) so updated_at > last_read_at is true
    expect(updated.last_read_at).toBeTruthy();
    expect(new Date(updated.last_read_at!).getFullYear()).toBeLessThanOrEqual(1970);
  });

  test('context menu Mark as Read works after Mark as Unread', async ({ page, request }) => {
    const suffix = Date.now();
    const title = `Ctx read ${suffix}`;
    const res = await request.post('/api/tickets', { headers, data: { title } });
    const ticket = await res.json() as { id: number };

    // Start as read
    await request.patch(`/api/tickets/${ticket.id}`, { headers, data: { last_read_at: new Date().toISOString() } });

    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) }).first();

    // First mark as unread
    await row.locator('.ticket-number').click();
    await row.locator('.ticket-number').click({ button: 'right' });
    await page.waitForTimeout(200);
    await page.locator('.context-menu-item').filter({ hasText: 'Mark as Unread' }).click();
    await page.waitForTimeout(500);

    // Verify unread via API
    let ticketRes = await request.get(`/api/tickets/${ticket.id}`, { headers });
    let updated = await ticketRes.json() as { last_read_at: string | null };
    // Mark as unread uses epoch date (not null) so updated_at > last_read_at is true
    expect(updated.last_read_at).toBeTruthy();
    expect(new Date(updated.last_read_at!).getFullYear()).toBeLessThanOrEqual(1970);

    // Now mark as read via context menu
    await row.locator('.ticket-number').click({ button: 'right' });
    await page.waitForTimeout(200);
    await page.locator('.context-menu-item').filter({ hasText: 'Mark as Read' }).click();
    await page.waitForTimeout(500);

    // Verify read via API
    ticketRes = await request.get(`/api/tickets/${ticket.id}`, { headers });
    updated = await ticketRes.json() as { last_read_at: string | null };
    expect(updated.last_read_at).not.toBeNull();
  });

  test('batch toolbar shows only Mark as Unread for read tickets (not both)', async ({ page, request }) => {
    const suffix = Date.now();
    const title = `Batch menu ${suffix}`;
    const res = await request.post('/api/tickets', { headers, data: { title } });
    const ticket = await res.json() as { id: number };

    // Start as read
    await request.patch(`/api/tickets/${ticket.id}`, { headers, data: { last_read_at: new Date().toISOString() } });

    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) }).first();
    await row.locator('.ticket-number').click();
    await page.waitForTimeout(300);

    // Open batch "..." menu
    await page.locator('#batch-more').click();
    await page.waitForTimeout(200);

    // Should show "Mark as Unread" (ticket is read) and NOT "Mark as Read"
    const items = page.locator('.dropdown-menu .dropdown-item');
    await expect(items.filter({ hasText: 'Mark as Unread' })).toBeVisible();
    await expect(items.filter({ hasText: /^Mark as Read$/ })).toBeHidden();

    // Should also show icons (Tags, Duplicate, etc.)
    await expect(items.filter({ hasText: 'Tags...' }).locator('.dropdown-icon')).toBeVisible();
    await expect(items.filter({ hasText: 'Duplicate' }).locator('.dropdown-icon')).toBeVisible();
  });

  test('mark as unread persists while detail panel is showing (no auto-read override)', async ({ page, request }) => {
    const suffix = Date.now();
    const title = `Persist unread ${suffix}`;
    const res = await request.post('/api/tickets', { headers, data: { title } });
    const ticket = await res.json() as { id: number };

    // Start with ticket as read
    await request.patch(`/api/tickets/${ticket.id}`, { headers, data: { last_read_at: new Date().toISOString() } });

    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Open detail panel
    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) }).first();
    await row.locator('.ticket-number').click();
    await expect(page.locator('#detail-header')).toBeVisible({ timeout: 3000 });
    await page.waitForTimeout(300);

    // Now mark as unread via context menu while detail is showing
    await row.locator('.ticket-number').click({ button: 'right' });
    await page.waitForTimeout(200);
    await page.locator('.context-menu-item').filter({ hasText: 'Mark as Unread' }).click();
    await page.waitForTimeout(500);

    // Wait for any potential auto-read to fire (poll cycle)
    await page.waitForTimeout(1000);

    // Verify it's still unread via API (auto-read should be suppressed)
    const ticketRes = await request.get(`/api/tickets/${ticket.id}`, { headers });
    const updated = await ticketRes.json() as { last_read_at: string | null };
    // Mark as unread uses epoch date (not null) so updated_at > last_read_at is true
    expect(updated.last_read_at).toBeTruthy();
    expect(new Date(updated.last_read_at!).getFullYear()).toBeLessThanOrEqual(1970);
  });
});
