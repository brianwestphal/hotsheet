/**
 * HS-9411 (docs/124) — the Settings → Experimental → "In Development" section.
 *
 * The unit tests pin the pure helpers + the cache; this spec proves the parts that
 * only exist in the running app: the gated surfaces are absent by default, a
 * checkbox reveals them without a reload, and the value persists to
 * `settings.local.json` and NOT the shared `settings.json` (the whole point of the
 * `dev_` prefix — these must never be committed for the team).
 */
import type { Page } from '@playwright/test';

import { DEV_FEATURES } from '../src/devFeatures.js';
import { expect, test } from './coverage-fixture.js';


const secretHeaders = (secret: string) => ({ 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret });

async function openExperimentalTab(page: Page): Promise<void> {
  // Opening Settings kicks off the Backups tab's snapshot-status fetch. A test that
  // reloads soon after would abort it and trip the HS-8435 console-error gate, so
  // arm the wait BEFORE the click (same pattern as e2e/commands.spec.ts).
  const snapSettled = page.waitForResponse(r => /\/api\/db\/snapshot-status/.test(r.url()), { timeout: 5000 }).catch(() => null);
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
  await page.locator('.settings-tab[data-tab="experimental"]').click();
  await expect(page.locator('.settings-tab-panel[data-panel="experimental"]')).toHaveClass(/active/);
  await snapSettled;
}

/** The In Development checkbox for a gate key. */
const gate = (page: Page, key: string) => page.locator(`.in-development-toggle[data-dev-key="${key}"]`);

test.describe('In Development gates (HS-9411)', () => {
  let secret = '';

  test.beforeEach(async ({ request }) => {
    const projects = await (await request.get('/api/projects')).json() as { secret: string }[];
    secret = projects[0]?.secret ?? '';
    expect(secret).not.toBe('');
    // Start from the default (all gates off) regardless of what ran before.
    await request.patch('/api/file-settings/layer', {
      headers: secretHeaders(secret),
      data: { layer: 'local', settings: { dev_parallel_workers: false, dev_remote_access: false } },
    });
  });

  test('the section renders one checkbox per gate, all off by default', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openExperimentalTab(page);

    const section = page.locator('.settings-section-in-development');
    await expect(section).toBeVisible();
    await expect(section.locator('.settings-in-development-note')).toContainText('at your own risk');

    // HS-9515 — derived from the registry rather than hard-coded. The literal 7 here
    // went stale the moment the five per-tool gates were removed, and a count that
    // has to be hand-updated tells you nothing about which gate changed.
    const toggles = page.locator('.in-development-toggle');
    await expect(toggles).toHaveCount(DEV_FEATURES.length);
    for (let i = 0; i < DEV_FEATURES.length; i++) await expect(toggles.nth(i)).not.toBeChecked();
  });

  test('Remote Access tab is hidden until its gate is on, and returns when enabled', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openExperimentalTab(page);

    const remoteTab = page.locator('#settings-tab-devices');
    await expect(remoteTab).toBeHidden();

    // Enabling applies immediately — no reload.
    await gate(page, 'dev_remote_access').check();
    await expect(remoteTab).toBeVisible();

    // …and unchecking hides it again.
    await gate(page, 'dev_remote_access').uncheck();
    await expect(remoteTab).toBeHidden();
  });

  test('a gate persists to settings.local.json and NOT the shared settings.json', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openExperimentalTab(page);

    await gate(page, 'dev_parallel_workers').check();

    const layered = async () => await (await request.get('/api/file-settings/layered', { headers: secretHeaders(secret) })).json() as {
      shared: Record<string, unknown>; local: Record<string, unknown>;
    };
    await expect.poll(async () => (await layered()).local.dev_parallel_workers, { timeout: 5000 }).toBe(true);
    // The load-bearing assertion: it must NOT be in the committed shared layer.
    expect((await layered()).shared.dev_parallel_workers).toBeUndefined();
  });

  test('the gate survives a reload', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openExperimentalTab(page);
    await gate(page, 'dev_remote_access').check();
    await expect(page.locator('#settings-tab-devices')).toBeVisible();

    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openExperimentalTab(page);
    await expect(gate(page, 'dev_remote_access')).toBeChecked();
    await expect(page.locator('#settings-tab-devices')).toBeVisible();
  });

  test('worker surfaces stay hidden with the parallel-workers gate off', async ({ page, request }) => {
    await request.post('/api/channel/enable', { headers: secretHeaders(secret) });
    try {
      await page.goto('/');
      await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
      // Channel enabled would normally reveal these two rows (HS-9039 / HS-9068);
      // the gate must win.
      await expect(page.locator('#sidebar-worker-actions')).toBeHidden();
      await expect(page.locator('#sidebar-worker-auto')).toBeHidden();
    } finally {
      await request.post('/api/channel/disable', { headers: secretHeaders(secret) });
    }
  });
});
