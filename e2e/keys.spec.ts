/**
 * HS-8751 — E2E for the global API-key registry UI: Settings → "API Keys" tab.
 * Add a key through the real form, confirm it renders as an editable row, and
 * confirm the Announcer's Anthropic key selector (Settings → Experimental) picks
 * up the new key via the `hotsheet:keys-changed` broadcast — i.e. the
 * project-level "pick a key by name" flow the ticket asked for.
 *
 * The `/api/keys` + `/api/announcer/*` routes are intercepted so the test never
 * touches the real OS keychain or `~/.hotsheet/config.json`; the server CRUD is
 * covered by `src/routes/keys.test.ts` + `src/secret-keys.test.ts`. This spec is
 * the only thing exercising the real client wiring (add → list → cross-section
 * selector refresh).
 */
import { expect, test } from './coverage-fixture.js';

interface KeyMeta { id: string; type: string; name: string }

test('API Keys tab: add a key → it lists → Announcer selector picks it up (HS-8751)', async ({ page }) => {
  const keys: KeyMeta[] = [];
  let selectedKeyId: string | null = null;

  await page.route(/\/api\/keys(\?|$)/, (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { type: string; name: string };
      const meta: KeyMeta = { id: `id-${String(keys.length + 1)}`, type: body.type, name: body.name };
      keys.push(meta);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ key: meta }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ keys }) });
  });
  await page.route('**/api/announcer/status**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ enabled: true, hasKey: keys.length > 0, selectedKeyId, entryCount: 0, lastListenedAt: null }),
  }));
  await page.route('**/api/announcer/key-selection**', (route) => {
    selectedKeyId = (route.request().postDataJSON() as { keyId: string | null }).keyId;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.goto('/');
  await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

  // Open Settings → API Keys tab.
  await page.locator('#settings-btn').click();
  await page.locator('.settings-tab[data-tab="keys"]').click();
  const panel = page.locator('#settings-keys-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.settings-keys-list')).toContainText('No keys yet');

  // Add an Anthropic key through the real form.
  await panel.locator('#settings-key-add-type').selectOption('anthropic_api_key');
  await panel.locator('#settings-key-add-name').fill('Personal');
  await panel.locator('#settings-key-add-value').fill('sk-ant-secret');
  await panel.locator('#settings-key-add-btn').click();

  // The row appears, name editable, value field write-only (empty).
  const row = panel.locator('.settings-key-row');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.settings-key-name')).toHaveValue('Personal');
  await expect(row.locator('.settings-key-value')).toHaveValue('');

  // Switch to Experimental → the Announcer key selector now offers the new key.
  await page.locator('.settings-tab[data-tab="experimental"]').click();
  const select = page.locator('#settings-announcer-key-select');
  await expect(select.locator('option')).toContainText(['Default', 'Personal']);

  // Selecting it posts the selection by id.
  await select.selectOption({ label: 'Personal' });
  await expect.poll(() => selectedKeyId).toBe('id-1');
});
