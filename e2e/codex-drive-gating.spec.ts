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
      await request.post('/api/channel/codex-app-server', { headers, data: { enabled: true } });
      await request.patch('/api/file-settings', { headers, data: { ai_tool: '' } });
      await request.patch('/api/settings', { headers, data: { custom_commands: '[]' } });
      await request.post('/api/channel/disable', { headers });
    } catch { /* best-effort cleanup */ }
  });

  test('toggle off hides play + prompt buttons (shell stays); Experimental checkbox re-enables', async ({ page, request }) => {
    // Arrange: channel on, ai_tool = codex, one prompt + one shell command.
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

    const playSection = page.locator('#channel-play-section');
    const promptBtn = page.locator('#channel-commands-container button', { hasText: PROMPT_CMD });
    const shellBtn = page.locator('#channel-commands-container button', { hasText: SHELL_CMD });

    // The ON-state visibility assertions share the channel-ui.spec.ts guard: the
    // play section also needs a sufficient `claude` CLI on the machine.
    const { meetsMinimum } = await (await request.get('/api/channel/claude-check', { headers })).json() as { meetsMinimum: boolean };

    if (meetsMinimum) {
      // (1) Default ON → the full drive surface is visible for the codex project.
      await expect(playSection).toBeVisible({ timeout: 5000 });
      await expect(promptBtn).toBeVisible();
      await expect(shellBtn).toBeVisible();
    }

    // (2) Toggle OFF via the API → play + prompt hidden, shell stays.
    await request.post('/api/channel/codex-app-server', { headers, data: { enabled: false } });
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(playSection).toBeHidden();
    await expect(promptBtn).toBeHidden();
    await expect(shellBtn).toBeVisible(); // shell commands are unaffected by the gate

    // The Experimental checkbox reflects the OFF state.
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible();
    await page.locator('.settings-tab[data-tab="experimental"]').click();
    const checkbox = page.locator('#settings-codex-app-server-enabled');
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();

    // (3) Re-enable via the checkbox → the change handler re-runs initChannel, so
    // the surface returns without a reload.
    await checkbox.check();
    await expect.poll(async () => {
      const status = await (await request.get('/api/channel/status', { headers })).json() as { codexAppServerEnabled?: boolean };
      return status.codexAppServerEnabled;
    }, { timeout: 5000 }).toBe(true);
    await page.locator('#settings-close').click();
    if (meetsMinimum) {
      await expect(playSection).toBeVisible({ timeout: 5000 });
      await expect(promptBtn).toBeVisible();
    }
    await expect(shellBtn).toBeVisible();
  });

  test('non-codex projects are unaffected by the toggle', async ({ page, request }) => {
    await request.post('/api/channel/enable', { headers });
    await request.patch('/api/file-settings', { headers, data: { ai_tool: 'claude' } });
    await request.post('/api/channel/codex-app-server', { headers, data: { enabled: false } });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const { meetsMinimum } = await (await request.get('/api/channel/claude-check', { headers })).json() as { meetsMinimum: boolean };
    if (meetsMinimum) {
      // The codex toggle being off must not hide a CLAUDE project's play section.
      await expect(page.locator('#channel-play-section')).toBeVisible({ timeout: 5000 });
    }
    // Restore for cleanliness (afterAll also resets).
    await request.post('/api/channel/codex-app-server', { headers, data: { enabled: true } });
  });
});
