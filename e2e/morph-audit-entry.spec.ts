/**
 * HS-9542 — the morph audit has to be reachable from a running page, and has to
 * still be measuring after a reset.
 *
 * Both of those were broken. HS-9538 shipped `morphAudit.ts` documenting a dev entry
 * that did not exist, so the instrument could not be run against the app at all; and
 * `resetMorphAudit()` also set `enabled = false`, so the documented workflow (enable
 * → drive → reset → drive → report) reported zeros because the audit was off for the
 * half being measured. That is the HS-9537 failure — an instrument that looks live
 * and reports nothing — recurring inside the fix for it.
 *
 * Neither is caught by a unit test, because both are about the wiring between the
 * page and the module. Hence a spec, and hence the assertions being positive
 * controls rather than assertions about redundancy numbers: this spec's job is to
 * prove the instrument works, not to pin what it currently measures.
 *
 * To re-measure by hand: load the app with `?morphAudit=1`, drive it, then read
 * `__hotsheetMorphAudit.report()` in the console.
 */
import { expect, test } from './coverage-fixture.js';

interface AuditRow { label: string; redundant: number; total: number }

test.describe('morph audit dev entry (HS-9542)', () => {
  test('opt-in wires the audit to the page and it keeps measuring across a reset', async ({ page }) => {
    test.setTimeout(120_000);

    // Off by default — the template serialization it needs is exactly the cost
    // `morph`'s byte-equal fast path exists to avoid, so production must not pay it.
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    expect(await page.evaluate(() =>
      (window as unknown as { __hotsheetMorphAudit?: unknown }).__hotsheetMorphAudit !== undefined),
    'the audit must be absent without the opt-in').toBe(false);

    await page.goto('/?morphAudit=1');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    expect(await page.evaluate(() =>
      (window as unknown as { __hotsheetMorphAudit?: unknown }).__hotsheetMorphAudit !== undefined),
    'the ?morphAudit=1 entry must expose the accessor').toBe(true);

    const secret = await page.evaluate(async () => {
      const projects = await (await fetch('/api/projects')).json() as { secret: string }[];
      return projects[0]?.secret ?? '';
    });
    const headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret };

    const ticket = await (await page.request.post('/api/tickets', {
      headers, data: { title: 'Morph audit entry', defaults: { details: '# Details\n\n**body**' } },
    })).json() as { id: number };
    await page.request.put(`/api/tickets/${String(ticket.id)}/notes-bulk`, {
      headers,
      data: { notes: JSON.stringify([{ id: 'ae1', text: 'A note with **markdown**.', created_at: new Date().toISOString() }]) },
    });

    await page.locator('.ticket-row[data-id]')
      .filter({ has: page.locator('.ticket-title-input[value="Morph audit entry"]') })
      .locator('.ticket-title-input').click();
    await expect(page.locator('#detail-notes .note-entry[data-note-id="ae1"]')).toBeVisible({ timeout: 10000 });

    // Reset, then drive more renders. If `reset()` switched the audit off — the
    // HS-9542 bug — everything after this point reports zero.
    await page.evaluate(() => {
      (window as unknown as { __hotsheetMorphAudit: { reset: () => void } }).__hotsheetMorphAudit.reset();
    });
    for (let i = 0; i < 4; i++) {
      await page.request.post('/api/tickets', { headers, data: { title: `entry churn ${String(i)}` } });
      await page.waitForTimeout(600);
    }

    const rows = await page.evaluate(() => {
      const w = window as unknown as { __hotsheetMorphAudit: { report: () => AuditRow[] } };
      return w.__hotsheetMorphAudit.report();
    });
    const totalRenders = rows.reduce((n, r) => n + r.total, 0);
    expect(totalRenders, 'the audit must still record renders AFTER a reset').toBeGreaterThan(0);
    expect(rows.some(r => r.label.includes('#detail-')), 'it must see the detail panel it is for').toBe(true);
  });
});
