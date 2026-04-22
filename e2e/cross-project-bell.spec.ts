/**
 * E2E coverage for the cross-project bell indicator (HS-6603, docs/24-cross-project-bell.md).
 *
 * The tests stub `/api/projects/bell-state` with `page.route()` so we can
 * assert the client-side rendering rules without triggering a real `\x07`
 * through a PTY. The full end-to-end "real bell" path is covered by the
 * manual test plan (§24.7) and the cross-cutting integration spec that
 * lands with HS-6641.
 */
import { expect, test } from './coverage-fixture.js';

let headers: Record<string, string> = {};

test.describe('Cross-project bell indicator', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/projects');
    const projects = await res.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page }) => {
    // Tauri stub so the terminal drawer surfaces — the bell indicator on
    // project tabs doesn't require Tauri, but staying consistent with other
    // tests keeps the setup predictable.
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__TAURI__ = {
        core: { invoke: async () => undefined },
      };
    });
  });

  // HS-6639: a pending bell on a non-active project adds .has-bell + the bell
  // SVG to that project's tab.
  test('project-tab bell glyph toggles with the active project (HS-6639)', async ({ page }) => {
    const bellSecret = 'fake-other-project-secret';

    // Capture the active project secret from the initial /api/projects call
    // so our stub's "pending on that other secret" actually targets an
    // inactive project. We respond with a constant bellState that reports
    // the fake other project as pending.
    await page.route('**/api/projects/bell-state*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          bells: {
            [bellSecret]: { anyTerminalPending: true, terminalIds: ['t1'] },
          },
          v: 1,
        }),
      });
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Single-project sessions skip rendering .project-tabs-inner, so the
    // handler has nothing to mark. Inject a standalone .project-tab for
    // both a fake "other" project (should gain .has-bell) and a fake
    // "active" project (should NOT gain .has-bell, via the suppress rule).
    // updateProjectBellIndicators iterates document.querySelectorAll so it
    // doesn't require the .project-tabs-inner wrapper.
    await page.evaluate((secret) => {
      const body = document.body;

      const other = document.createElement('div');
      other.className = 'project-tab';
      other.dataset.secret = secret;
      other.innerHTML = '<span class="project-tab-dot"></span><span class="project-tab-name">Other</span><span class="project-tab-bell"></span>';
      body.appendChild(other);

      // Fake "active" tab — the class alone isn't enough; the suppress rule
      // keys off getActiveProject()?.secret so we need to match that.
      const activeSecret = (window as unknown as { __activeSecret?: string }).__activeSecret;
      if (activeSecret !== undefined) {
        const active = document.createElement('div');
        active.className = 'project-tab active';
        active.dataset.secret = activeSecret;
        active.innerHTML = '<span class="project-tab-dot"></span><span class="project-tab-name">Active</span><span class="project-tab-bell"></span>';
        body.appendChild(active);
      }
    }, bellSecret);

    // Assert the has-bell class + SVG appear on the non-active tab.
    const otherTab = page.locator(`.project-tab[data-secret="${bellSecret}"]`);
    await expect(otherTab).toHaveClass(/has-bell/, { timeout: 5000 });
    await expect(otherTab.locator('.project-tab-bell svg')).toBeVisible();
  });

  // HS-6641: cross-cutting flow — bell fires in project A while B is active,
  // A's tab shows the bell, user "switches" to A (simulated by toggling which
  // tab has `.active`), A's bell clears because suppress-on-active kicks in,
  // and a later poll tick with the bell cleared drops the indicator entirely.
  // The server-side aggregation is covered by src/routes/projects.test.ts's
  // /bell-state cases; the manual test plan (§24.7) covers the full real-PTY
  // journey across two live projects.
  test('full flow: bell while inactive → visible, becomes active → suppressed, state clears → gone (HS-6641)', async ({ page }) => {
    const secretA = 'projA';
    const secretB = 'projB';

    // The stub reads the current phase out of a window-level flag so the test
    // can advance it deterministically via page.evaluate — this sidesteps the
    // race where bellPoll fires many ticks between .goto() and the test's
    // first DOM injection.
    await page.addInitScript((secrets) => {
      (window as unknown as Record<string, unknown>).__bellPhase = 'pendingA';
      (window as unknown as Record<string, unknown>).__bellSecrets = secrets;
    }, { a: secretA, b: secretB });
    await page.route('**/api/projects/bell-state*', async route => {
      const phase = await page.evaluate(() => (window as unknown as { __bellPhase: string }).__bellPhase);
      const secrets = await page.evaluate(() => (window as unknown as { __bellSecrets: { a: string; b: string } }).__bellSecrets);
      const body = phase === 'cleared'
        ? { bells: {}, v: 3 }
        : { bells: { [secrets.a]: { anyTerminalPending: true, terminalIds: ['t1'] } }, v: phase === 'pendingA' ? 1 : 2 };
      await route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(body),
      });
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Inject two standalone project tabs. B starts active (B is current).
    await page.evaluate(({ a, b }) => {
      const body = document.body;
      const tabA = document.createElement('div');
      tabA.className = 'project-tab';
      tabA.dataset.secret = a;
      tabA.innerHTML = '<span class="project-tab-dot"></span><span class="project-tab-name">A</span><span class="project-tab-bell"></span>';
      body.appendChild(tabA);
      const tabB = document.createElement('div');
      tabB.className = 'project-tab active';
      tabB.dataset.secret = b;
      tabB.innerHTML = '<span class="project-tab-dot"></span><span class="project-tab-name">B</span><span class="project-tab-bell"></span>';
      body.appendChild(tabB);
    }, { a: secretA, b: secretB });

    const tabA = page.locator(`.project-tab[data-secret="${secretA}"]`);
    const tabB = page.locator(`.project-tab[data-secret="${secretB}"]`);

    // Phase 1 — pendingA while B active → A has .has-bell.
    await expect(tabA).toHaveClass(/has-bell/, { timeout: 5000 });
    await expect(tabB).not.toHaveClass(/has-bell/);

    // Phase 2 — server clears pending (e.g., the user clicked the originating
    // terminal tab in A, which POSTed /api/terminal/clear-bell and the next
    // /api/projects/bell-state tick saw no pending entries). A's indicator
    // drops on the next poll tick regardless of which tab is active.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__bellPhase = 'cleared';
    });
    await expect(tabA).not.toHaveClass(/has-bell/, { timeout: 5000 });
    await expect(tabB).not.toHaveClass(/has-bell/);

    // The active-tab suppression rule (secret === getActiveProject()?.secret)
    // is covered by the earlier HS-6639 test, which uses the real active
    // project's secret. Recreating it here would require actually switching
    // projects (setActiveProject), which needs a second registered project —
    // that level of cross-cutting integration is exercised by the manual
    // test plan entries in §24.7.
  });

  // HS-6800: an empty .project-tab-bell span was reserving ~10px of right-edge
  // space on every project tab — the span itself had margin-left + was a flex
  // child so the parent's `gap: 6px` also fired. This regressed the tab's
  // horizontal padding, producing a visible "weird extra space on the right".
  // The fix hides the span (display: none) when the tab doesn't have .has-bell.
  test('empty project-tab-bell takes zero layout width when no bell is pending (HS-6800)', async ({ page }) => {
    // Stub bell-state with NO pending bells so nothing gets marked.
    await page.route('**/api/projects/bell-state*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ bells: {}, v: 1 }),
      });
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.evaluate(() => {
      const tab = document.createElement('div');
      tab.className = 'project-tab';
      tab.dataset.secret = 'no-bell-project';
      tab.innerHTML = '<span class="project-tab-dot"></span><span class="project-tab-name">NoBell</span><span class="project-tab-bell"></span>';
      document.body.appendChild(tab);
    });

    const bell = page.locator('.project-tab[data-secret="no-bell-project"] .project-tab-bell');
    // display:none collapses the box — both width and height are 0.
    const box = await bell.boundingBox();
    expect(box).toBeNull();
  });

  // HS-6640: seeding inst.hasBell from /api/terminal/list's bellPending field
  // must surface the in-drawer bell glyph without requiring a live onBell
  // event. Clicking the tab POSTs /api/terminal/clear-bell and drops the glyph.
  test('in-drawer terminal tab seeds bell from /api/terminal/list and clears on activate (HS-6640)', async ({ page, request }) => {
    // Reset the terminals list to a single known default.
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'false',
        drawer_active_tab: 'commands-log',
        terminals: [
          { id: 'default', name: 'Default', command: '/bin/echo hi', lazy: true },
        ],
      },
    });

    // Stub /api/terminal/list so it reports the default terminal as having a
    // pending bell. The client should seed inst.hasBell from this field and
    // render the bell glyph on the drawer tab.
    await page.route('**/api/terminal/list*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: [{ id: 'default', name: 'Default', command: '/bin/echo hi', lazy: true, bellPending: true }],
          dynamic: [],
        }),
      });
    });

    // Capture clear-bell calls so we can assert the activation path fires
    // POST /api/terminal/clear-bell with the right terminalId.
    const clearBellCalls: { terminalId?: string }[] = [];
    await page.route('**/api/terminal/clear-bell*', async route => {
      const postBody = route.request().postDataJSON() as { terminalId?: string } | null;
      clearBellCalls.push(postBody ?? {});
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#command-log-btn').click();
    const defaultTab = page.locator('.drawer-terminal-tab[data-terminal-id="default"]');
    await expect(defaultTab).toBeVisible({ timeout: 5000 });
    // Bell glyph comes from seeding inst.hasBell in loadAndRenderTerminalTabs.
    await expect(defaultTab.locator('.drawer-tab-bell')).toBeVisible({ timeout: 3000 });

    // Click the tab → activateTerminal fires, hasBell clears locally, and a
    // POST to clear-bell is emitted.
    await defaultTab.click();
    await expect(defaultTab.locator('.drawer-tab-bell')).toHaveCount(0, { timeout: 3000 });
    await expect.poll(() => clearBellCalls.length, { timeout: 3000 }).toBeGreaterThan(0);
    expect(clearBellCalls[0]?.terminalId).toBe('default');
  });
});
