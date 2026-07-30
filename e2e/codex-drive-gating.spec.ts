/**
 * HS-9390 (docs/121 §121.7) — browser E2E for the codex drive surface gating:
 * with `ai_tool = codex`, the Experimental "Codex app-server drive" toggle
 * (default ON) controls the play section + custom PROMPT command buttons, while
 * SHELL command buttons stay regardless. No live codex needed — the gate acts
 * purely on `/channel/status` fields (`shouldHideCodexDriveSurface`).
 *
 * The per-worker e2e server runs with an isolated temp HOME, so the
 * machine-global `~/.hotsheet/config.json` writes here never touch the real one.
 */
import { expect, test } from './coverage-fixture.js';

const PROMPT_CMD = 'E2E Codex Prompt Cmd';
const SHELL_CMD = 'E2E Codex Shell Cmd';

test.describe('Codex drive surface gating (HS-9390)', () => {
  let headers: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    const projects = await (await request.get('/api/projects')).json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.afterAll(async ({ request }) => {
    // Reset shared-server state so later specs aren't affected.
    try {
      await request.patch('/api/file-settings', { headers, data: { ai_tool: '' } });
      await request.patch('/api/settings', { headers, data: { custom_commands: '[]' } });
      await request.post('/api/channel/disable', { headers });
    } catch { /* best-effort cleanup */ }
  });

  // HS-9513 — the drive ENABLE/DISABLE toggle is gone, so the old "toggle off → surface
  // hides → checkbox re-enables" journey no longer exists to test. What replaced it is a
  // handshake-FAILURE state, which can't be forced from here without a broken `codex`
  // binary — that logic is unit-tested (`codexDriveGate.test.ts`, `codexDriveRetry.test.ts`).
  //
  // What IS worth asserting end-to-end is that the removed controls are actually gone.
  // A leftover checkbox writing a key nothing reads, or a live endpoint flipping a flag
  // nothing honours, would both look perfectly healthy while doing nothing at all.
  test('the removed drive toggle is gone from the UI and the API', async ({ page, request }) => {
    await request.post('/api/channel/enable', { headers });
    await request.patch('/api/file-settings', { headers, data: { ai_tool: 'codex' } });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible();
    await page.locator('.settings-tab[data-tab="experimental"]').click();
    await expect(page.locator('#settings-codex-app-server-enabled')).toHaveCount(0);
    await page.locator('#settings-close').click();

    // The endpoint it drove is gone too; the status no longer carries the flag.
    const stale = await request.post('/api/channel/codex-app-server', { headers, data: { enabled: false } });
    expect(stale.status()).toBe(404);
    const status = await (await request.get('/api/channel/status', { headers })).json() as Record<string, unknown>;
    expect(status).not.toHaveProperty('codexAppServerEnabled');
  });

  test('a healthy codex project keeps its play + prompt surface, and the retry row stays hidden', async ({ page, request }) => {
    await request.post('/api/channel/enable', { headers });
    await request.patch('/api/file-settings', { headers, data: { ai_tool: 'codex' } });
    await request.patch('/api/settings', {
      headers,
      data: {
        custom_commands: JSON.stringify([
          { name: PROMPT_CMD, prompt: 'process the worklist' },
          { name: SHELL_CMD, prompt: 'echo hi', target: 'shell' },
        ]),
      },
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const shellBtn = page.locator('#channel-commands-container button', { hasText: SHELL_CMD });
    // The play-surface assertions share the channel-ui.spec.ts guard: they also need a
    // sufficient `claude` CLI on the machine.
    const { meetsMinimum } = await (await request.get('/api/channel/claude-check', { headers })).json() as { meetsMinimum: boolean };
    if (meetsMinimum) {
      await expect(page.locator('#channel-play-section')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('#channel-commands-container button', { hasText: PROMPT_CMD })).toBeVisible();
    }
    await expect(shellBtn).toBeVisible();
    // No failure ⇒ no retry row. It appears only in place of a hidden play surface.
    await expect(page.locator('#codex-drive-failed-row')).toBeHidden();
  });

  // HS-9513 — the model-B toggle is GONE (the flag it wrote no longer exists), so its
  // "defaults ON and round-trips through /global-config" test went with it. What
  // replaces it is the assertion that the control is absent: a stray checkbox writing a
  // key nothing reads would look fine in the UI and do nothing at all.
  test('the removed model-B toggle is no longer rendered', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible();
    await page.locator('.settings-tab[data-tab="experimental"]').click();

    await expect(page.locator('#settings-codex-model-b-terminals')).toHaveCount(0);
    await page.locator('#settings-close').click();
  });

  test('non-codex projects are unaffected by codex drive state', async ({ page, request }) => {
    await request.post('/api/channel/enable', { headers });
    await request.patch('/api/file-settings', { headers, data: { ai_tool: 'claude' } });
    // HS-9513 — the retry is codex-scoped; running it must not disturb a claude project.
    await request.post('/api/channel/codex-drive/retry', { headers });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const { meetsMinimum } = await (await request.get('/api/channel/claude-check', { headers })).json() as { meetsMinimum: boolean };
    if (meetsMinimum) {
      await expect(page.locator('#channel-play-section')).toBeVisible({ timeout: 5000 });
    }
    await expect(page.locator('#codex-drive-failed-row')).toBeHidden();
  });
});
