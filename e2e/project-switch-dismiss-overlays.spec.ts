/**
 * HS-9441 — transient overlays must not survive a project switch.
 *
 * A hover/anchor-based overlay is dismissed by an event on its ANCHOR
 * (`mouseleave`, `blur`, an outside `click`). A project switch rebuilds the UI those
 * anchors live in, so the anchor is removed while the overlay is up and the
 * dismissing event never fires — the overlay is orphaned on screen, still showing
 * the PREVIOUS project's data.
 *
 * **Why these tests switch with `dispatchEvent('click')`.** Playwright's normal
 * `click()` MOVES the mouse to the target tab first, which fires a legitimate
 * `mouseleave` on the hovered button and hides the tooltip — a spec written that way
 * passes even with the bug present. `dispatchEvent` delivers the click without
 * moving the pointer, reproducing the real condition (and the ticket's "switching
 * quickly"): the cursor never leaves the button, the button is torn out from under
 * it. It still runs the tab's real handler → `switchProject`.
 *
 * `src/client/transientOverlays.test.ts` covers the dismissal matrix in isolation;
 * this spec is the one that proves the WIRING — that `switchProject` actually calls
 * it — through the real app.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';


const CMD_NAME = 'E2E Tooltip Cmd';

/** The active project's secret. */
async function activeSecret(page: Page): Promise<string> {
  return await page.evaluate(() => document.querySelector<HTMLElement>('.project-tab.active')?.dataset.secret ?? '');
}

test.describe('Project switch dismisses transient overlays (HS-9441)', () => {
  test('a command tooltip hovered in one project does not survive the switch', async ({ page, request }) => {
    // The shell command whose button we hover lives in a throwaway project, so the
    // shared project A's settings are never mutated (as in
    // e2e/project-switch-settings-reset.spec.ts). Shell-target commands render
    // regardless of channel state, so this needs no Claude connection.
    const dataDir = join(mkdtempSync(join(tmpdir(), 'hs-9441-')), '.hotsheet');
    const res = await request.post('/api/projects/register', { data: { dataDir } });
    expect(res.ok(), 'second project should register').toBeTruthy();
    const projB = await res.json() as { secret: string };

    try {
      await request.patch('/api/settings', {
        headers: { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projB.secret },
        data: {
          custom_commands: JSON.stringify([
            { id: 'e2e-9441', name: CMD_NAME, prompt: 'echo hello-9441', target: 'shell', icon: 'send', color: '#3b82f6' },
          ]),
        },
      });

      await page.goto('/');
      await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
      const tabB = page.locator(`.project-tab[data-secret="${projB.secret}"]`);
      await expect(tabB).toBeVisible({ timeout: 5000 });
      const secretA = await activeSecret(page);
      expect(secretA).not.toBe('');

      // Go to B (a real click is fine here — we only need to ARRIVE at B).
      await tabB.click();
      await expect(page.locator(`.project-tab.active[data-secret="${projB.secret}"]`)).toBeVisible({ timeout: 5000 });

      const btn = page.locator('.channel-command-btn', { hasText: CMD_NAME });
      await expect(btn).toBeVisible({ timeout: 10000 });

      // Hover → the tooltip appears, showing THIS project's command.
      await btn.hover();
      const tooltip = page.locator('.command-tooltip:not([hidden])');
      await expect(tooltip).toBeVisible({ timeout: 5000 });
      await expect(tooltip).toContainText(CMD_NAME);

      // Switch back to A without moving the pointer off the button.
      await page.locator(`.project-tab[data-secret="${secretA}"]`).dispatchEvent('click');
      await expect(page.locator(`.project-tab.active[data-secret="${secretA}"]`)).toBeVisible({ timeout: 5000 });

      // The orphan check. Pre-fix this stayed visible indefinitely.
      await expect(page.locator('.command-tooltip:not([hidden])')).toHaveCount(0, { timeout: 5000 });
      // And B's command button is gone (its commands don't leak into A).
      await expect(page.locator('.channel-command-btn', { hasText: CMD_NAME })).toHaveCount(0);
    } finally {
      await request.delete(`/api/projects/${projB.secret}`).catch(() => undefined);
    }
  });

  // OUTCOME test, not a regression guard — and deliberately labeled as such.
  // Verified by disabling the fix: this one still passes, because a dispatched click
  // on the tab BUBBLES to `contextMenu.tsx`'s document-level outside-click handler,
  // which closes the menu on its own. It is kept because the user-visible guarantee
  // ("no menu orphaned across a switch") is worth pinning by whatever path delivers
  // it; the new dismissal path for `.context-menu` is covered in
  // `src/client/transientOverlays.test.ts`. The tooltip test above is the one that
  // fails without the fix — it was checked the same way.
  test('a ticket context menu does not survive the switch', async ({ page, request }) => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'hs-9441-ctx-')), '.hotsheet');
    const res = await request.post('/api/projects/register', { data: { dataDir } });
    expect(res.ok(), 'second project should register').toBeTruthy();
    const projB = await res.json() as { secret: string };

    try {
      await page.goto('/');
      await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
      const tabB = page.locator(`.project-tab[data-secret="${projB.secret}"]`);
      await expect(tabB).toBeVisible({ timeout: 5000 });

      // Need a ticket to right-click in the CURRENT project.
      const rows = page.locator('.ticket-row[data-id]');
      if (await rows.count() === 0) {
        await page.locator('.draft-input').first().fill('HS-9441 context-menu fixture');
        await page.locator('.draft-input').first().press('Enter');
      }
      await expect(rows.first()).toBeVisible({ timeout: 10000 });

      await rows.first().click({ button: 'right' });
      await expect(page.locator('.context-menu')).toBeVisible({ timeout: 5000 });

      await tabB.dispatchEvent('click');
      await expect(page.locator(`.project-tab.active[data-secret="${projB.secret}"]`)).toBeVisible({ timeout: 5000 });
      await expect(page.locator('.context-menu')).toHaveCount(0, { timeout: 5000 });
    } finally {
      await request.delete(`/api/projects/${projB.secret}`).catch(() => undefined);
    }
  });
});
