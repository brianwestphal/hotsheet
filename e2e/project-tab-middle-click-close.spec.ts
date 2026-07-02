/**
 * HS-9265 — middle-clicking a top-level project tab closes it (same behavior as
 * the context-menu "Close Tab": guarded on the last remaining project + prompts
 * when the tab has running/non-exempt terminals). With no running terminals here
 * it closes without a prompt.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './coverage-fixture.js';

interface RegisteredProject { name: string; dataDir: string; secret: string }

test.describe('Middle-click project tab to close (HS-9265)', () => {
  let projB: RegisteredProject | null = null;

  test.afterEach(async ({ request }) => {
    if (projB) await request.delete(`/api/projects/${projB.secret}`).catch(() => undefined);
    projB = null;
  });

  test('middle-click removes the tab (no running terminals → no prompt)', async ({ page, request }) => {
    // Register a real second project so there are two tabs (removeProject guards
    // the last remaining project).
    const dataDir = join(mkdtempSync(join(tmpdir(), 'hs-9265-')), '.hotsheet');
    const res = await request.post('/api/projects/register', { data: { dataDir } });
    expect(res.ok(), 'second project should register').toBeTruthy();
    projB = await res.json() as RegisteredProject;

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    const tabB = page.locator(`.project-tab[data-secret="${projB.secret}"]`);
    await expect(tabB).toBeVisible({ timeout: 5000 });

    // Middle-click the second project's tab → it closes (no confirm dialog since
    // the temp project has no running terminals).
    await tabB.click({ button: 'middle' });

    await expect(tabB).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('.confirm-dialog-overlay')).toHaveCount(0);
    // The project is gone server-side too.
    const projects = await (await request.get('/api/projects')).json() as { secret: string }[];
    expect(projects.some(p => p.secret === projB!.secret)).toBe(false);
    projB = null; // already removed — skip afterEach delete
  });
});
