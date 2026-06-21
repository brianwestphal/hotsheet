import { expect, test } from './coverage-fixture.js';

/**
 * HS-8913 / §86 — AI-assistant instruction sections in CLAUDE.md.
 *
 * Exercises the real round-trip against the running server's temp project:
 *   - GET /api/ai-instructions/status reports install state,
 *   - POST /api/ai-instructions/apply installs the managed sections (idempotent),
 *   - and the Settings → General "Update CLAUDE.md" button drives the same apply
 *     through the UI.
 */

interface SectionStatus { id: string; present: boolean; needsSetup: boolean }
interface StatusResp { setupNeeded: boolean; missing: boolean; sections: SectionStatus[] }

test.describe('AI assistant instructions (HS-8913 / §86)', () => {
  let secret: string;

  test.beforeAll(async ({ request }) => {
    const projects = await request.get('/api/projects').then((r) => r.json()) as { secret: string }[];
    secret = projects[0]?.secret ?? '';
    expect(secret).not.toBe('');
  });

  test('apply installs the managed sections and is idempotent', async ({ request }) => {
    const headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret };

    // First apply — writes the sections (the temp project starts without them,
    // or they were left by a prior run; either way apply converges).
    const applied = await request.post('/api/ai-instructions/apply', { headers }).then((r) => r.json()) as { written: boolean; state: StatusResp };
    expect(applied.state.setupNeeded).toBe(false);
    expect(applied.state.sections.length).toBeGreaterThanOrEqual(3);
    expect(applied.state.sections.every((s) => s.present)).toBe(true);

    // Status now reports everything present + current.
    const status = await request.get('/api/ai-instructions/status').then((r) => r.json()) as StatusResp;
    expect(status.missing).toBe(false);
    expect(status.setupNeeded).toBe(false);
    expect(status.sections.find((s) => s.id === 'ticket-driven-work')).toBeTruthy();
    // The testing + requirements specifics blocks ship unfilled (needs-setup).
    expect(status.sections.find((s) => s.id === 'testing-philosophy')!.needsSetup).toBe(true);

    // Second apply — nothing to change.
    const again = await request.post('/api/ai-instructions/apply', { headers }).then((r) => r.json()) as { written: boolean };
    expect(again.written).toBe(false);
  });

  test('Settings → General button updates CLAUDE.md', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible();
    // General tab is the default active panel.
    const btn = page.locator('#ai-instructions-update-btn');
    await expect(btn).toBeVisible();
    await btn.click();

    // Status line resolves to a real outcome (applied or already-current).
    await expect(page.locator('#ai-instructions-status')).toContainText(/CLAUDE\.md|up to date/i, { timeout: 10000 });
  });
});
