/**
 * HS-9711 — feedback-needed tickets always bubble to the top of the list, and to
 * the top of their own column on the board, regardless of the chosen sort.
 *
 * The pin these tests defend: server-side bubbling (`feedbackBubblePrefix` in
 * `src/db/tickets.ts`) ranks a ticket whose LAST meaningful note contains
 * `FEEDBACK NEEDED` ahead of everything else, so a ticket that would otherwise
 * sort LAST surfaces first. Column view groups by status client-side while
 * preserving that server order, so the same card lands atop its column.
 */
import type { Page } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

async function getProjectSecret(page: Page): Promise<string> {
  const res = await page.request.get('/api/projects');
  const projects = await res.json() as { secret: string }[];
  return projects[0]?.secret ?? '';
}

/** Persist the dismissed AI-instructions nudge before the first navigation so
 *  its modal overlay can't intercept clicks after a reload (see feedback-drafts). */
async function suppressAiInstructionsNudge(page: Page): Promise<void> {
  const secret = await getProjectSecret(page);
  await page.request.patch('/api/file-settings', {
    headers: { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret },
    data: { ai_instructions_nudge_dismissed: true },
  });
}

async function createTicket(page: Page, title: string): Promise<void> {
  const draft = page.locator('.draft-input');
  await draft.fill(title);
  await draft.press('Enter');
  await expect(page.locator(`.ticket-row[data-id] .ticket-title-input[value="${title}"]`)).toBeVisible({ timeout: 5000 });
}

/** Append a real FEEDBACK NEEDED note to a ticket via the notes-bulk API (the
 *  same wire path the channel uses). */
async function addFeedbackNote(page: Page, title: string, prompt: string): Promise<void> {
  const secret = await getProjectSecret(page);
  const headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret };
  const ticketId = Number(await page.locator('.ticket-row[data-id]')
    .filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) }).getAttribute('data-id'));
  const ticket = await (await page.request.get(`/api/tickets/${ticketId}`, { headers })).json() as { notes: string };
  const existing = (() => {
    try { const p: unknown = JSON.parse(ticket.notes); return Array.isArray(p) ? p as unknown[] : []; }
    catch { return []; }
  })();
  const notes = [...existing, { id: `n_test_${Date.now().toString(36)}`, text: `FEEDBACK NEEDED: ${prompt}`, created_at: new Date().toISOString() }];
  const res = await page.request.put(`/api/tickets/${ticketId}/notes-bulk`, { headers, data: { notes: JSON.stringify(notes) } });
  if (!res.ok()) throw new Error(`notes-bulk PUT failed: ${res.status()} ${await res.text()}`);
}

/** Titles of the `Bubble ` tickets, in DOM order, for a set of rows/cards. */
async function bubbleOrder(page: Page, selector: string): Promise<string[]> {
  const titles = await page.locator(selector).evaluateAll(els =>
    els.map(el => {
      const input = el.querySelector<HTMLInputElement>('.ticket-title-input');
      if (input) return input.value;
      const cardTitle = el.querySelector<HTMLElement>('.column-card-title');
      return (cardTitle ?? el).textContent;
    }));
  return titles.map(t => t.trim()).filter(t => t.startsWith('Bubble '));
}

test.describe('Feedback-needed bubbling (HS-9711)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await suppressAiInstructionsNudge(page);
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    // Created oldest→newest; default sort (created desc) would put "Bubble one" LAST.
    await createTicket(page, 'Bubble one');
    await createTicket(page, 'Bubble two');
    await createTicket(page, 'Bubble three');
    await createTicket(page, 'Bubble four');
    // Flag the ticket that would otherwise sort last.
    await addFeedbackNote(page, 'Bubble one', 'which way?');
    await page.goto('/'); // fresh load → server re-bubbles
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('list view lifts the feedback-needed ticket to the top', async ({ page }) => {
    await expect(page.locator('#ticket-list')).not.toHaveClass(/ticket-list-columns/, { timeout: 5000 });
    await expect.poll(() => bubbleOrder(page, '.ticket-row[data-id]'), { timeout: 8000 })
      .toEqual(['Bubble one', 'Bubble four', 'Bubble three', 'Bubble two']);
    // Sanity: its purple feedback-needed border is present.
    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Bubble one"]') });
    await expect(row).toHaveClass(/feedback-needed/, { timeout: 5000 });
  });

  test('column view lifts it to the top of its own column', async ({ page }) => {
    await page.locator('.layout-btn[data-layout="columns"]').click();
    await expect(page.locator('#ticket-list')).toHaveClass(/ticket-list-columns/, { timeout: 5000 });
    // All four are not_started, so they share the Not Started column; the
    // feedback-needed one is first within it.
    await expect.poll(
      () => bubbleOrder(page, '.column[data-status="not_started"] .column-card[data-id]'),
      { timeout: 8000 },
    ).toEqual(['Bubble one', 'Bubble four', 'Bubble three', 'Bubble two']);
  });
});
