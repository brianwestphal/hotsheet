/**
 * HS-9584 — a terminal with no explicit `name` and an AI command template is
 * labelled **AI**, not "claude".
 *
 * The template is `ai_tool`-aware — `{{aiCommand}}` and the legacy
 * `{{claudeCommand}}` alias both expand through `pickAiCommand` on the server —
 * so a project set to codex/antigravity/opencode used to get a tab labelled
 * after a tool it does not run. `src/client/terminalLabelFromCommand.test.ts`
 * pins the derivation; this proves the label a user actually reads in the
 * drawer, which is where the bug was reported from.
 */
import type { APIRequestContext } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

async function secretFor(request: APIRequestContext): Promise<string> {
  const projects = await (await request.get('/api/projects')).json() as { secret: string }[];
  return projects[0]?.secret ?? '';
}

test.describe('Nameless AI terminal is labelled "AI" (HS-9584)', () => {
  test('the drawer tab reads AI for both command templates, and the tool name for a literal binary', async ({ page, request }) => {
    const headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': await secretFor(request) };
    await request.patch('/api/file-settings', {
      headers,
      data: {
        drawer_open: 'true',
        drawer_active_tab: 'commands-log',
        terminals: [
          // No `name` on any of these — the label is derived.
          { id: 'ai', command: '{{aiCommand}}', lazy: true },
          { id: 'legacy', command: '{{claudeCommand}}', lazy: true },
          { id: 'shell', command: '/bin/zsh', lazy: true },
        ],
      },
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 5000 });

    const labelFor = (id: string) =>
      page.locator(`.drawer-tab[data-drawer-tab="terminal:${id}"] .drawer-tab-label`);

    await expect(labelFor('ai')).toHaveText('AI', { timeout: 5000 });
    await expect(labelFor('legacy')).toHaveText('AI');
    // Unchanged: a path-style command still shows its basename.
    await expect(labelFor('shell')).toHaveText('zsh');
  });

  test('an explicit name still wins — the fix does not rewrite what the user chose', async ({ page, request }) => {
    const headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': await secretFor(request) };
    await request.patch('/api/file-settings', {
      headers,
      data: {
        drawer_open: 'true',
        drawer_active_tab: 'commands-log',
        terminals: [{ id: 'ai', name: 'Claude', command: '{{aiCommand}}', lazy: true }],
      },
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.drawer-tab[data-drawer-tab="terminal:ai"] .drawer-tab-label'))
      .toHaveText('Claude', { timeout: 5000 });
  });
});
