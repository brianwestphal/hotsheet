import { expect, test } from './coverage-fixture.js';

/**
 * HS-9516 (docs/116) — the blocked-reason editor is one row when empty and matches the
 * Details textarea's height once it has content. It shipped at a fixed 2 rows: taller
 * than nothing when unused and shorter than Details when used, which is backwards.
 *
 * Note the height is compared via `rows`, not pixels. The Details TEXTAREA is hidden
 * until you click into it (HS-8020 renders markdown alongside it), so it has no bounding
 * box on load — a pixel comparison against it would measure 0 and pass for the wrong
 * reason. The blocked field's own pixel height is still asserted, since that is the
 * change a user actually sees.
 */
test('HS-9516 — blocked reason is 1 row empty, Details height when filled', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  await page.locator('.draft-input').fill('HS-9516 sizing probe');
  await page.locator('.draft-input').press('Enter');
  await page.locator('.ticket-row').first().click();

  const blocked = page.locator('#detail-blocked-reason');
  const details = page.locator('#detail-details');
  await expect(blocked).toBeVisible();

  const rows = async (l: typeof blocked): Promise<number> => Number(await l.getAttribute('rows'));
  const height = async (l: typeof blocked): Promise<number> => (await l.boundingBox())?.height ?? 0;

  expect(await rows(blocked)).toBe(1);
  const emptyH = await height(blocked);
  expect(emptyH).toBeGreaterThan(0);

  await blocked.fill('waiting on something');
  expect(await rows(blocked)).toBe(await rows(details)); // matches Details, not a literal
  expect(await height(blocked)).toBeGreaterThan(emptyH);

  // Collapses again when cleared — the direction a one-way implementation would miss.
  await blocked.fill('');
  expect(await rows(blocked)).toBe(1);
  expect(Math.abs(await height(blocked) - emptyH)).toBeLessThan(2);
});
