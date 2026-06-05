/**
 * HS-8737 / HS-8738 — tag suggestions must be consistent and project-scoped.
 *
 * The Tags dialog fetches the project's tag set fresh on open (`getTags()` →
 * `/tags` → `getAllTags()`, scoped to the active project, excluding deleted
 * tickets). The detail-panel tag autocomplete used a module-level
 * `allKnownTags` cache seeded once at app init and only ever pushed to — so a
 * tag added via the **dialog** (which doesn't touch the cache) never showed up
 * in the autocomplete, and the cache leaked the previous project's tags after
 * a switch. Fix: the autocomplete refreshes the cache on focus (and on project
 * switch), so both surfaces show the same live, current-project set.
 *
 * This spec reproduces the dialog↔autocomplete divergence within a single
 * project (the cross-project leak is the same cache, exercised by the
 * refresh-on-switch wiring + the inherently project-scoped server query).
 */
import { expect, test } from './coverage-fixture.js';

async function createTicket(page: import('@playwright/test').Page, title: string) {
  const draft = page.locator('.draft-input');
  await draft.fill(title);
  await draft.press('Enter');
  await expect(page.locator(`.ticket-row[data-id] .ticket-title-input[value="${title}"]`)).toBeVisible({ timeout: 5000 });
}

async function openDetail(page: import('@playwright/test').Page, title: string) {
  const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) });
  await row.locator('.ticket-number').click();
  await expect(page.locator('#detail-header')).toBeVisible({ timeout: 5000 });
}

test.describe('Tag suggestion consistency (HS-8737 / HS-8738)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('a tag added via the Tags dialog appears in the detail-panel autocomplete', async ({ page }) => {
    // Create a ticket (auto-selected) and add a brand-new tag via the DIALOG —
    // the dialog path updates the ticket but historically did NOT push the new
    // tag into the autocomplete's allKnownTags cache.
    await createTicket(page, 'Alpha');
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('hotsheet:show-tags-dialog')));
    await expect(page.locator('.tags-dialog')).toBeVisible({ timeout: 5000 });
    await page.locator('#tags-dialog-new-input').fill('dialogonly');
    await page.locator('#tags-dialog-add-btn').click();
    await page.locator('#tags-dialog-done').click();
    await expect(page.locator('.tags-dialog')).toBeHidden({ timeout: 5000 });

    // On a DIFFERENT ticket, focus the detail tag input. The autocomplete must
    // now list the dialog-added tag (refresh-on-focus pulls the live set).
    await createTicket(page, 'Beta');
    await openDetail(page, 'Beta');
    await page.locator('#detail-tag-input').click();
    await expect(
      page.locator('.tag-autocomplete .tag-autocomplete-item').filter({ hasText: 'Dialogonly' }),
    ).toBeVisible({ timeout: 5000 });
  });

  test('the Tags dialog and the autocomplete show the same set after a tag is added in the detail panel', async ({ page }) => {
    // Add a tag via the detail input on one ticket...
    await createTicket(page, 'Gamma');
    await openDetail(page, 'Gamma');
    const tagInput = page.locator('#detail-tag-input');
    await tagInput.fill('detailtag');
    await tagInput.press('Enter');
    await expect(page.locator('#detail-tags .tag-chip').filter({ hasText: 'Detailtag' })).toBeVisible({ timeout: 5000 });

    // ...and assert it shows up in the dialog opened on another ticket (the
    // dialog already fetched fresh; this pins that the two sources agree).
    await createTicket(page, 'Delta');
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('hotsheet:show-tags-dialog')));
    await expect(page.locator('.tags-dialog')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.tags-dialog-row').filter({ hasText: 'Detailtag' })).toBeVisible({ timeout: 5000 });
    await page.locator('#tags-dialog-cancel').click();

    // And it also shows in the autocomplete on Delta.
    await openDetail(page, 'Delta');
    await page.locator('#detail-tag-input').click();
    await expect(
      page.locator('.tag-autocomplete .tag-autocomplete-item').filter({ hasText: 'Detailtag' }),
    ).toBeVisible({ timeout: 5000 });
  });
});
