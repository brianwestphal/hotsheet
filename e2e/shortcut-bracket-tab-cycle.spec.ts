/**
 * HS-9443 — Cmd/Ctrl+Shift+[ / ] must actually cycle the project tab.
 *
 * The matchers compared `e.key` against `[` / `]`, but a browser reports the
 * character the chord PRODUCES — `{` / `}` with Shift held — so both chords were
 * unreachable. `shortcutsMatchers.test.ts` pins the predicate against synthetic
 * events; this spec presses the real keys in a real browser, which is the only way
 * to prove the engine's `e.key` and the matcher agree. (The unit test alone would
 * have passed against the buggy matcher too, had it asserted the wrong character —
 * only a live keypress settles what the browser sends.)
 *
 * Also covers the input-focus case explicitly: the bracket chords are the ONLY
 * project-cycling path that works while a text input has focus (`Cmd/Ctrl+Shift+Arrow`
 * deliberately falls through to text selection there), and the draft input is focused
 * by default — so this is the everyday path.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './coverage-fixture.js';

type Page = import('@playwright/test').Page;

async function activeSecret(page: Page): Promise<string> {
  return await page.evaluate(() => document.querySelector<HTMLElement>('.project-tab.active')?.dataset.secret ?? '');
}

test.describe('Bracket shortcuts cycle project tabs (HS-9443)', () => {
  test('Cmd/Ctrl+Shift+] then +[ move to the next project and back', async ({ page, request }) => {
    // A second project so there is something to cycle to.
    const dataDir = join(mkdtempSync(join(tmpdir(), 'hs-9443-')), '.hotsheet');
    const res = await request.post('/api/projects/register', { data: { dataDir } });
    expect(res.ok(), 'second project should register').toBeTruthy();
    const projB = await res.json() as { secret: string };

    try {
      await page.goto('/');
      await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
      await expect(page.locator(`.project-tab[data-secret="${projB.secret}"]`)).toBeVisible({ timeout: 5000 });

      const before = await activeSecret(page);
      expect(before).not.toBe('');

      // Focus the draft input — the everyday state, and the one where the Arrow
      // chords intentionally do nothing.
      await page.locator('.draft-input').first().click();

      await page.keyboard.press('ControlOrMeta+Shift+BracketRight');
      await expect.poll(() => activeSecret(page), { timeout: 5000 }).not.toBe(before);

      await page.keyboard.press('ControlOrMeta+Shift+BracketLeft');
      await expect.poll(() => activeSecret(page), { timeout: 5000 }).toBe(before);
    } finally {
      await request.delete(`/api/projects/${projB.secret}`).catch(() => undefined);
    }
  });
});
