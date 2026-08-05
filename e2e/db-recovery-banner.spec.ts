/**
 * HS-9576 (docs/135) — the empty-cluster banner, as the user meets it.
 *
 * The server half is proven end to end in `src/db/emptyClusterSurfacing.e2e.test.ts`
 * (real process, real guard, real route). What that cannot show is the part the
 * ticket is actually about: whether a user staring at an empty project is TOLD
 * anything. So this drives the browser and stubs only the one endpoint whose
 * state is impractical to produce in a shared test server — the marker itself.
 *
 * The stub is the real wire shape (`src/api/db.ts::RecoveryMarkerSchema`), so a
 * field rename still breaks this spec at the client parse boundary.
 */
import { expect, test } from './coverage-fixture.js';

const EMPTY_CLUSTER_MARKER = {
  marker: {
    kind: 'empty-cluster',
    corruptPath: '',
    recoveredAt: new Date().toISOString(),
    errorMessage: '',
    priorTicketCount: 432,
  },
};

const CORRUPT_OPEN_MARKER = {
  marker: {
    kind: 'corrupt-open',
    corruptPath: '/tmp/hotsheet/db-corrupt-1754300000000',
    recoveredAt: new Date().toISOString(),
    errorMessage: 'Aborted(). Build with -sASSERTIONS for more info.',
  },
};

test.describe('DB recovery banner — empty cluster (HS-9576)', () => {
  test('tells the user their data is missing, what is protected, and where to look', async ({ page }) => {
    await page.route('**/api/db/recovery-status**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_CLUSTER_MARKER),
    }));

    await page.goto('/');
    const banner = page.locator('#db-recovery-banner');
    await expect(banner).toBeVisible({ timeout: 10000 });

    const label = page.locator('#db-recovery-banner-label');
    await expect(label).toContainText('database is empty');
    await expect(label).toContainText('432 tickets');
    // The reassurance — the existing copies are being actively kept, not merely
    // available. Without it the banner reads as a second loss.
    await expect(label).toContainText('paused');
    await expect(label).toContainText('Settings → Backups');
    // HS-9575 made the preserved directories selectable; a user who does not
    // know they exist restores an older backup and loses the difference.
    await expect(label).toContainText('db-corrupt-');
    // It must NOT reuse the corrupt-open wording — nothing failed to load here.
    await expect(label).not.toContainText('failed to load');
  });

  test('the restore button opens Settings, where Backups and Repair live', async ({ page }) => {
    await page.route('**/api/db/recovery-status**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_CLUSTER_MARKER),
    }));

    await page.goto('/');
    await expect(page.locator('#db-recovery-banner')).toBeVisible({ timeout: 10000 });
    await page.locator('#db-recovery-restore-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 10000 });
  });

  test('dismiss hides it and clears the marker server-side', async ({ page }) => {
    let dismissed = false;
    await page.route('**/api/db/recovery-status**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(dismissed ? { marker: null } : EMPTY_CLUSTER_MARKER),
    }));
    await page.route('**/api/db/dismiss-recovery**', (route) => {
      dismissed = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/');
    await expect(page.locator('#db-recovery-banner')).toBeVisible({ timeout: 10000 });
    await page.locator('#db-recovery-dismiss-btn').click();
    await expect(page.locator('#db-recovery-banner')).toBeHidden();
    expect(dismissed).toBe(true);
  });

  test('a corrupt-open marker still gets the original copy', async ({ page }) => {
    await page.route('**/api/db/recovery-status**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(CORRUPT_OPEN_MARKER),
    }));

    await page.goto('/');
    const label = page.locator('#db-recovery-banner-label');
    await expect(label).toContainText('Database failed to load', { timeout: 10000 });
    await expect(label).toContainText('Aborted()');
  });

  test('a healthy project shows no banner at all', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#db-recovery-banner')).toBeHidden();
  });
});
