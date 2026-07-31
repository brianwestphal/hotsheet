/**
 * HS-9406 — the command editor's "AI agent" target button is labeled with the
 * project's `ai_tool` (HS-9364), read from `state.settings.ai_tool`. Two ways
 * that state went stale, both user-visible as a Claude project's segmented
 * control saying "Codex":
 *
 *  1. Picking a tool in Settings never wrote the new value into state, so the
 *     label only caught up on the next reload.
 *  2. `loadSettings()` (which `reloadAppState()` runs on every project switch)
 *     only assigned `ai_tool` when the NEW project actually set one — so a
 *     project that leaves it unset inherited the previous project's tool.
 *
 * The unit tests (`settingsLoader.test.ts`) pin the hydration transitions; this
 * spec drives the real UI, including a genuinely-registered second project so
 * the switch path is exercised end-to-end.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';


const COMMANDS = JSON.stringify([{ name: 'Agent Cmd', prompt: 'do something' }]);

const secretHeaders = (secret: string) => ({ 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret });

/** Click a project tab and wait for the switch's settings reload to land.
 *  `reloadAppState()` re-fetches the layered file settings for the new project;
 *  the label under test is read from that response, so arm the wait BEFORE the
 *  click rather than racing an in-flight hydration. */
async function switchToProject(page: Page, secret: string): Promise<void> {
  const hydrated = page.waitForResponse(
    (r) => r.url().includes('/api/file-settings/layered') && r.url().includes(`project=${secret}`),
    { timeout: 10000 },
  );
  await page.locator(`.project-tab[data-secret="${secret}"]`).click();
  await expect(page.locator(`.project-tab.active[data-secret="${secret}"]`)).toBeVisible({ timeout: 5000 });
  await hydrated;
}

/** Open Settings → Commands in Shared mode (editing needs a writable layer). */
async function openCommandsSettings(page: Page): Promise<void> {
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
  await page.locator('.settings-tab[data-tab="commands"]').click();
  await expect(page.locator('.settings-tab-panel[data-panel="commands"]')).toHaveClass(/active/);
  await page.locator('.scope-seg-btn.scope-seg-shared').click();
  await expect(page.locator('.cmd-outline-add-btn')).toBeVisible({ timeout: 5000 });
}

/** Open the first command's editor and return its "AI agent" segmented label. */
async function readAgentSegLabel(page: Page): Promise<string> {
  await page.locator('.cmd-outline-row .cmd-outline-edit-btn').first().click();
  const modal = page.locator('.cmd-editor-overlay');
  await expect(modal).toBeVisible({ timeout: 3000 });
  const label = (await modal.locator('.seg-btn[data-target="claude"]').textContent()) ?? '';
  await modal.locator('.cmd-editor-close-btn').click();
  await expect(modal).toBeHidden({ timeout: 3000 });
  return label.trim();
}

test.describe('Command editor agent label (HS-9406)', () => {
  let mainSecret = '';

  test.beforeEach(async ({ request }) => {
    const projects = await (await request.get('/api/projects')).json() as { secret: string }[];
    mainSecret = projects[0]?.secret ?? '';
    expect(mainSecret).not.toBe('');
    await request.patch('/api/settings', { headers: secretHeaders(mainSecret), data: { custom_commands: COMMANDS } });
  });

  test.afterEach(async ({ request }) => {
    // Reset the shared server's project so later specs aren't affected.
    await request.patch('/api/file-settings', { headers: secretHeaders(mainSecret), data: { ai_tool: '' } }).catch(() => undefined);
    await request.patch('/api/settings', { headers: secretHeaders(mainSecret), data: { custom_commands: '[]' } }).catch(() => undefined);
  });

  test('follows the AI-tool dropdown without a reload', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openCommandsSettings(page);

    // Default (`auto`/unset) → "Claude".
    expect(await readAgentSegLabel(page)).toBe('Claude');

    // Switch the tool and re-open the editor WITHOUT reloading the page.
    await page.locator('.settings-tab[data-tab="general"]').click();
    await page.locator('#ai-tool-select').selectOption('codex');
    await page.locator('.settings-tab[data-tab="commands"]').click();
    await expect(page.locator('.cmd-outline-add-btn')).toBeVisible({ timeout: 5000 });
    expect(await readAgentSegLabel(page)).toBe('Codex');

    // And back — no reload either.
    await page.locator('.settings-tab[data-tab="general"]').click();
    await page.locator('#ai-tool-select').selectOption('auto');
    await page.locator('.settings-tab[data-tab="commands"]').click();
    await expect(page.locator('.cmd-outline-add-btn')).toBeVisible({ timeout: 5000 });
    expect(await readAgentSegLabel(page)).toBe('Claude');
  });

  test('a codex project\'s tool does not carry into a project that leaves it unset', async ({ page, request }) => {
    // Register a real second project against a throwaway temp dir, seeded with
    // `ai_tool = codex` + a command of its own. (Unregistered afterward like
    // e2e/cross-project-drag.spec.ts; the temp dir is left for the OS to reap —
    // the server still holds its PGLite handle.)
    const dataDir = join(mkdtempSync(join(tmpdir(), 'hs-9406-')), '.hotsheet');
    const res = await request.post('/api/projects/register', { data: { dataDir } });
    expect(res.ok(), 'second project should register').toBeTruthy();
    const projB = await res.json() as { secret: string };

    try {
      const headersB = secretHeaders(projB.secret);
      await request.patch('/api/file-settings', { headers: headersB, data: { ai_tool: 'codex' } });
      await request.patch('/api/settings', { headers: headersB, data: { custom_commands: COMMANDS } });

      await page.goto('/');
      await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
      const tabB = page.locator(`.project-tab[data-secret="${projB.secret}"]`);
      await expect(tabB).toBeVisible({ timeout: 5000 });
      const secretA = await page.evaluate(() => document.querySelector<HTMLElement>('.project-tab.active')?.dataset.secret ?? '');
      expect(secretA).not.toBe('');

      // Project B labels its AI-agent target "Codex"...
      await switchToProject(page, projB.secret);
      await openCommandsSettings(page);
      expect(await readAgentSegLabel(page)).toBe('Codex');
      await page.locator('#settings-close').click();
      await expect(page.locator('#settings-overlay')).toBeHidden({ timeout: 3000 });

      // ...and switching back to A (which never set `ai_tool`) must say "Claude".
      // Pre-fix it inherited B's "Codex".
      await switchToProject(page, secretA);
      await openCommandsSettings(page);
      expect(await readAgentSegLabel(page)).toBe('Claude');
    } finally {
      await request.delete(`/api/projects/${projB.secret}`).catch(() => undefined);
    }
  });
});
