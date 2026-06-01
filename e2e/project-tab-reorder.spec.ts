/**
 * E2E coverage for project-tab drag-to-reorder (HS-8431).
 *
 * Two related regressions shipped together under HS-8431:
 *
 *   1. `<div draggable={true}>` in JSX serialized as a bare `draggable`
 *      HTML attribute, which the HTML spec treats as the "auto"
 *      enumerated state — a `<div>` in "auto" mode is **not** draggable.
 *      Fix: `draggable="true"` (the string keyword). Unit-tested in
 *      `src/client/projectTabs.test.ts`.
 *
 *   2. `handleDrop` wrote the new order via `projectsStore.state.value
 *      .projects = next` — a direct property mutation on the signal's
 *      value object. Kerf signals only emit on `set(...)`; without going
 *      through the `reorderProjects` action, `bindList` never noticed
 *      and the tabs visually stayed put. Fix: route the write through
 *      `projectsStore.actions.reorderProjects(orderedSecrets)`.
 *
 * Bug #1 is observable from a unit test (the attribute shape is what
 * `getAttribute` returns). Bug #2 is only observable end-to-end —
 * happy-dom can synthesize a DragEvent but the unit harness uses
 * `_setProjectsForTesting`, which goes through the same action the fix
 * uses, so it can't detect the production wiring drifting back to
 * direct mutation. This spec dispatches a real drag/drop sequence in
 * the browser and asserts both the DOM rearrangement (proving
 * reactivity flowed) and the `/api/projects/reorder` POST body (proving
 * the persistence call still carries the right order).
 *
 * The shared Hot Sheet instance only has one real project, so we mock
 * `/api/projects` to return three (with the real secret as the first /
 * active one, so any subsequent API call that auths by active-secret
 * still works against the real backend).
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Project tab drag-to-reorder (HS-8431)', () => {
  test('drag tab Alpha onto the right half of tab Gamma → order becomes Beta, Gamma, Alpha', async ({ page, request }) => {
    // Grab the real project's secret so the active-tab mock entry can
    // auth against the real backend for everything that isn't reorder.
    const projects = await (await request.get('/api/projects')).json() as { secret: string }[];
    const realSecret = projects[0]?.secret ?? '';
    expect(realSecret, 'expected at least one real project to exist').not.toBe('');

    // Mock the project list to look like three projects to the client.
    // First entry's secret must match the real backend's so initProjectTabs
    // picks it as the active project + every subsequent auth'd call works.
    // Regex pattern catches both `/api/projects` (the bootstrap call
    // before `setActiveProject` runs) AND `/api/projects?project=...`
    // (every subsequent GET, since the api helper auto-appends the
    // active-project query string). A bare `**/api/projects` glob
    // misses the second form.
    await page.route(/\/api\/projects(\?.*)?$/, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { name: 'Alpha', dataDir: '/tmp/hs-8431-alpha', secret: realSecret, ticketCount: 0 },
          { name: 'Beta',  dataDir: '/tmp/hs-8431-beta',  secret: 'hs-8431-beta-secret', ticketCount: 0 },
          { name: 'Gamma', dataDir: '/tmp/hs-8431-gamma', secret: 'hs-8431-gamma-secret', ticketCount: 0 },
        ]),
      });
    });

    // Intercept the reorder POST so the test can assert on its body
    // without polluting the shared backend's actual projects.json.
    let reorderBody: { secrets: string[] } | null = null;
    await page.route('**/api/projects/reorder', async route => {
      reorderBody = route.request().postDataJSON() as { secrets: string[] };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/');

    // Multi-tab strip should mount with three tabs in the mocked order.
    const tabs = page.locator('.project-tab');
    await expect(tabs).toHaveCount(3);
    await expect(page.locator('.project-tab .project-tab-name')).toHaveText(['Alpha', 'Beta', 'Gamma']);

    // The first regression: every tab must carry `draggable="true"` (not
    // a bare `draggable` attribute, which is the "auto" state → not
    // draggable for divs). Reading the attribute through Playwright is
    // the strictest possible probe — happy-dom + a real Chromium agree
    // that `getAttribute('draggable')` returns `''` for a bare attribute
    // and `'true'` for the keyword form.
    for (let i = 0; i < 3; i++) {
      await expect(tabs.nth(i)).toHaveAttribute('draggable', 'true');
    }

    // Dispatch a synthetic drag sequence: dragstart on Alpha, dragover +
    // drop on Gamma at a clientX past Gamma's midpoint → handleDrop's
    // `side === 'after'` branch → Alpha lands AFTER Gamma → order
    // becomes Beta, Gamma, Alpha. Mirrors the pattern from
    // `e2e/ticket-row-drop.spec.ts:54-57`.
    await page.evaluate(() => {
      const allTabs = document.querySelectorAll<HTMLElement>('.project-tab');
      const alpha = allTabs[0];
      const gamma = allTabs[2];
      const dt = new DataTransfer();
      alpha.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const gammaRect = gamma.getBoundingClientRect();
      const dropX = gammaRect.right - 4;
      const dropY = gammaRect.top + gammaRect.height / 2;
      gamma.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: dropX, clientY: dropY }));
      gamma.dispatchEvent(new DragEvent('drop',     { bubbles: true, cancelable: true, dataTransfer: dt, clientX: dropX, clientY: dropY }));
      alpha.dispatchEvent(new DragEvent('dragend',  { bubbles: true, cancelable: true, dataTransfer: dt }));
    });

    // The DOM must reflect the new order — this is the primary
    // regression assertion for bug #2. If handleDrop reverts to direct
    // signal-value mutation (or any other path that skips the kerf
    // action), bindList won't reconcile and this expectation fails.
    await expect(page.locator('.project-tab .project-tab-name')).toHaveText(['Beta', 'Gamma', 'Alpha']);

    // The persistence POST must have fired with the same order so a
    // page refresh / next session sees the new arrangement.
    expect(reorderBody).not.toBeNull();
    expect(reorderBody!.secrets).toEqual(['hs-8431-beta-secret', 'hs-8431-gamma-secret', realSecret]);
  });

  test('drag tab Gamma onto the left half of tab Alpha → order becomes Gamma, Alpha, Beta', async ({ page, request }) => {
    // Mirror of the first test but exercises the `side === 'before'`
    // branch of `handleDrop`. Both halves need coverage because pre-fix
    // the midpoint math was the only piece of the handler that had any
    // implicit testing (via the `_setProjectsForTesting` path), so a
    // future refactor that breaks one direction but not the other would
    // slip past a single-direction test.
    const projects = await (await request.get('/api/projects')).json() as { secret: string }[];
    const realSecret = projects[0]?.secret ?? '';

    // Regex pattern catches both `/api/projects` (the bootstrap call
    // before `setActiveProject` runs) AND `/api/projects?project=...`
    // (every subsequent GET, since the api helper auto-appends the
    // active-project query string). A bare `**/api/projects` glob
    // misses the second form.
    await page.route(/\/api\/projects(\?.*)?$/, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { name: 'Alpha', dataDir: '/tmp/hs-8431-alpha', secret: realSecret, ticketCount: 0 },
          { name: 'Beta',  dataDir: '/tmp/hs-8431-beta',  secret: 'hs-8431-beta-secret', ticketCount: 0 },
          { name: 'Gamma', dataDir: '/tmp/hs-8431-gamma', secret: 'hs-8431-gamma-secret', ticketCount: 0 },
        ]),
      });
    });

    let reorderBody: { secrets: string[] } | null = null;
    await page.route('**/api/projects/reorder', async route => {
      reorderBody = route.request().postDataJSON() as { secrets: string[] };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/');
    await expect(page.locator('.project-tab')).toHaveCount(3);
    await expect(page.locator('.project-tab .project-tab-name')).toHaveText(['Alpha', 'Beta', 'Gamma']);

    await page.evaluate(() => {
      const allTabs = document.querySelectorAll<HTMLElement>('.project-tab');
      const alpha = allTabs[0];
      const gamma = allTabs[2];
      const dt = new DataTransfer();
      gamma.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const alphaRect = alpha.getBoundingClientRect();
      const dropX = alphaRect.left + 4;
      const dropY = alphaRect.top + alphaRect.height / 2;
      alpha.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: dropX, clientY: dropY }));
      alpha.dispatchEvent(new DragEvent('drop',     { bubbles: true, cancelable: true, dataTransfer: dt, clientX: dropX, clientY: dropY }));
      gamma.dispatchEvent(new DragEvent('dragend',  { bubbles: true, cancelable: true, dataTransfer: dt }));
    });

    await expect(page.locator('.project-tab .project-tab-name')).toHaveText(['Gamma', 'Alpha', 'Beta']);
    expect(reorderBody).not.toBeNull();
    expect(reorderBody!.secrets).toEqual(['hs-8431-gamma-secret', realSecret, 'hs-8431-beta-secret']);
  });

  // Third regression — the production reason the user's drop kept
  // snapping back: a poll-driven `refreshProjectTabs` race. The two
  // tests above pass without any guard because nothing in the e2e
  // setup bumps `/api/poll`'s version while the user is dragging, so
  // `refreshProjectTabs` never fires. In production the long-poll
  // bumps constantly (Claude Code heartbeats, ticket activity, channel
  // status), each bump fires `refreshProjectTabs`, and an unawaited
  // `/api/projects/reorder` POST loses to a concurrent GET that
  // returns the pre-reorder order. This test reproduces the race
  // deterministically: a slow reorder POST + a poll mock that bumps
  // version immediately. Without the `pendingReorderSecrets` guard the
  // tabs revert within ~100 ms of the drop; with the guard they hold
  // their new order for the duration of the POST.
  test('reorder survives a refreshProjectTabs race during the in-flight POST (HS-8431)', async ({ page, request }) => {
    const projects = await (await request.get('/api/projects')).json() as { secret: string }[];
    const realSecret = projects[0]?.secret ?? '';

    // `/api/projects` ALWAYS returns the pre-reorder order — simulates
    // the worst-case race where the GET arrives before the server has
    // processed our POST. In production the server would catch up
    // once the POST lands; here the stale response is permanent so
    // every poll-driven refresh fires the bug path.
    // Regex pattern catches both `/api/projects` (the bootstrap call
    // before `setActiveProject` runs) AND `/api/projects?project=...`
    // (every subsequent GET, since the api helper auto-appends the
    // active-project query string). A bare `**/api/projects` glob
    // misses the second form.
    await page.route(/\/api\/projects(\?.*)?$/, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { name: 'Alpha', dataDir: '/tmp/hs-8431-alpha', secret: realSecret, ticketCount: 0 },
          { name: 'Beta',  dataDir: '/tmp/hs-8431-beta',  secret: 'hs-8431-beta-secret', ticketCount: 0 },
          { name: 'Gamma', dataDir: '/tmp/hs-8431-gamma', secret: 'hs-8431-gamma-secret', ticketCount: 0 },
        ]),
      });
    });

    // Reorder POST is slow — keeps `pendingReorderSecrets` set for the
    // duration of the test's race window.
    await page.route('**/api/projects/reorder', async route => {
      await new Promise(r => setTimeout(r, 1500));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    // `/api/poll` bumps version on every call so the poll loop keeps
    // firing `refreshProjectTabs`. Pre-fix each invocation lands a
    // `setProjects([Alpha, Beta, Gamma])` and the tabs immediately
    // snap back. The unit test covers the underlying guard logic;
    // this test proves it survives a real running poll loop.
    let pollVersion = 0;
    await page.route('**/api/poll**', async route => {
      pollVersion += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: pollVersion, dataVersion: pollVersion }) });
    });

    await page.goto('/');
    await expect(page.locator('.project-tab')).toHaveCount(3);
    await expect(page.locator('.project-tab .project-tab-name')).toHaveText(['Alpha', 'Beta', 'Gamma']);

    // Drop Alpha onto Gamma's right half — same shape as the first
    // test but the assertions afterward focus on the race.
    await page.evaluate(() => {
      const allTabs = document.querySelectorAll<HTMLElement>('.project-tab');
      const alpha = allTabs[0];
      const gamma = allTabs[2];
      const dt = new DataTransfer();
      alpha.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const gammaRect = gamma.getBoundingClientRect();
      const dropX = gammaRect.right - 4;
      const dropY = gammaRect.top + gammaRect.height / 2;
      gamma.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: dropX, clientY: dropY }));
      gamma.dispatchEvent(new DragEvent('drop',     { bubbles: true, cancelable: true, dataTransfer: dt, clientX: dropX, clientY: dropY }));
      alpha.dispatchEvent(new DragEvent('dragend',  { bubbles: true, cancelable: true, dataTransfer: dt }));
    });

    // Immediately after drop the tabs MUST be in the new order.
    await expect(page.locator('.project-tab .project-tab-name')).toHaveText(['Beta', 'Gamma', 'Alpha']);

    // The race window. During the next 800 ms the poll loop runs
    // multiple iterations — each fires a `refreshProjectTabs` that
    // GETs the stale `[Alpha, Beta, Gamma]` order. Sample the DOM
    // several times to catch any moment the guard fails to hold.
    // Pre-fix this loop catches the revert within the first ~150 ms.
    const samples: string[][] = [];
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 100));
      samples.push(await page.locator('.project-tab .project-tab-name').allTextContents());
    }

    // Every sample taken during the POST window MUST be the post-drop
    // order. A single revert anywhere in the run fails the test.
    for (const sample of samples) {
      expect(sample, 'tabs reverted during the in-flight reorder POST window').toEqual(['Beta', 'Gamma', 'Alpha']);
    }
  });

  // HS-8431 follow-up — the user reported that even after the three
  // fixes above shipped, dropping a tab still snapped back. Their setup:
  // 9 projects, dragging the LAST tab two spots forward. The synthetic
  // DragEvent tests above only mock 3 tabs and only assert on text
  // content, so a bug where the drop's effect is visually invisible (or
  // suppressed by some other paint pass) would slip past them. This
  // test mirrors the user's exact scenario: 9 projects + drag the last
  // onto the 7th's left half + screenshot before/after the drop so a
  // human can diff the rendered tab strip.
  test('drag 9th tab 2 spots forward — full screenshot verification (HS-8431)', async ({ page, request }) => {
    const projects = await (await request.get('/api/projects')).json() as { secret: string }[];
    const realSecret = projects[0]?.secret ?? '';

    // Build a 9-project list. P1 is the real backend so auth'd calls
    // (poll, settings, etc.) keep working; P2..P9 are mock-only secrets.
    const mockProjects = [
      { name: 'P1', dataDir: '/tmp/hs-8431-p1', secret: realSecret, ticketCount: 0 },
      { name: 'P2', dataDir: '/tmp/hs-8431-p2', secret: 'hs-8431-p2-secret', ticketCount: 0 },
      { name: 'P3', dataDir: '/tmp/hs-8431-p3', secret: 'hs-8431-p3-secret', ticketCount: 0 },
      { name: 'P4', dataDir: '/tmp/hs-8431-p4', secret: 'hs-8431-p4-secret', ticketCount: 0 },
      { name: 'P5', dataDir: '/tmp/hs-8431-p5', secret: 'hs-8431-p5-secret', ticketCount: 0 },
      { name: 'P6', dataDir: '/tmp/hs-8431-p6', secret: 'hs-8431-p6-secret', ticketCount: 0 },
      { name: 'P7', dataDir: '/tmp/hs-8431-p7', secret: 'hs-8431-p7-secret', ticketCount: 0 },
      { name: 'P8', dataDir: '/tmp/hs-8431-p8', secret: 'hs-8431-p8-secret', ticketCount: 0 },
      { name: 'P9', dataDir: '/tmp/hs-8431-p9', secret: 'hs-8431-p9-secret', ticketCount: 0 },
    ];

    await page.route(/\/api\/projects(\?.*)?$/, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockProjects) });
    });

    let reorderBody: { secrets: string[] } | null = null;
    await page.route('**/api/projects/reorder', async route => {
      reorderBody = route.request().postDataJSON() as { secrets: string[] };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    // Bump poll version on every call so the real production race
    // (poll-driven refresh during in-flight POST) gets exercised.
    let pollVersion = 0;
    await page.route('**/api/poll**', async route => {
      pollVersion += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ version: pollVersion, dataVersion: pollVersion }),
      });
    });

    // Capture browser console + page errors — if there's a runtime error
    // during the drop sequence it's invisible to the existing tests.
    const consoleLogs: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', msg => consoleLogs.push(`${msg.type()}: ${msg.text()}`));
    page.on('pageerror', err => pageErrors.push(err.message));

    await page.goto('/');
    const tabStrip = page.locator('.project-tabs-inner');
    await expect(tabStrip).toBeVisible();
    await expect(page.locator('.project-tab')).toHaveCount(9);
    await expect(page.locator('.project-tab .project-tab-name')).toHaveText(
      ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9'],
    );

    // Screenshot the initial state.
    await tabStrip.screenshot({ path: 'test-results/hs-8431-before.png' });

    // Drag P9 onto P7's left half → P9 should land BEFORE P7
    // → order becomes [P1..P6, P9, P7, P8].
    const allTabs = page.locator('.project-tab');
    const p9 = allTabs.nth(8);
    const p7 = allTabs.nth(6);

    const p9Box = await p9.boundingBox();
    const p7Box = await p7.boundingBox();
    if (p9Box === null || p7Box === null) {
      throw new Error('could not measure tab boundaries');
    }

    // First: a real mouse-down + drift on P9 just so the browser sees a
    // physical drag-start gesture. Some browsers won't begin a drag
    // unless the mouse moves a few pixels with the button down — this
    // matches how a real user starts a drag, while still falling back
    // to synthetic DragEvent dispatch below for the actual handler
    // wiring (Playwright's headless Chromium doesn't reliably translate
    // page.mouse activity into HTML5 drag events).
    await page.mouse.move(p9Box.x + p9Box.width / 2, p9Box.y + p9Box.height / 2);
    await page.mouse.down();
    await page.mouse.move(p9Box.x + p9Box.width / 2 + 5, p9Box.y + p9Box.height / 2);
    await page.mouse.up();

    // Now drive the actual HTML5 drag/drop event chain. dragstart on
    // P9 → dragover on P7 (left half) → drop on P7 → dragend on P9.
    // This is the same shape as the tests above but the assertion side
    // is much richer: screenshots + many DOM samples + console / page
    // error capture.
    await page.evaluate(({ p7LeftX, p7Y }: { p7LeftX: number; p7Y: number }) => {
      const tabs = document.querySelectorAll<HTMLElement>('.project-tab');
      const dragP9 = tabs[8];
      const dropP7 = tabs[6];
      const dt = new DataTransfer();
      dragP9.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      dropP7.dispatchEvent(new DragEvent('dragover',  { bubbles: true, cancelable: true, dataTransfer: dt, clientX: p7LeftX, clientY: p7Y }));
      dropP7.dispatchEvent(new DragEvent('drop',      { bubbles: true, cancelable: true, dataTransfer: dt, clientX: p7LeftX, clientY: p7Y }));
      dragP9.dispatchEvent(new DragEvent('dragend',   { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, { p7LeftX: p7Box.x + 4, p7Y: p7Box.y + p7Box.height / 2 });

    // Immediately after the drop, the DOM should show the new order.
    await expect(page.locator('.project-tab .project-tab-name')).toHaveText(
      ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P9', 'P7', 'P8'],
    );

    // Screenshot the after-drop state.
    await tabStrip.screenshot({ path: 'test-results/hs-8431-after.png' });

    // Sample the DOM repeatedly for 1.5 s to catch a revert that
    // might not be instant. Pre-fix the revert happened within ~100 ms
    // of the drop; sampling at 100 ms intervals for 1500 ms gives 15
    // chances to spot the bug. Also screenshot the final state for
    // visual comparison.
    const samples: string[][] = [];
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 100));
      samples.push(await page.locator('.project-tab .project-tab-name').allTextContents());
    }
    await tabStrip.screenshot({ path: 'test-results/hs-8431-after-1500ms.png' });

    // Log captured console + page errors so a failure is easier to
    // diagnose. Playwright's --reporter=line truncates these but the
    // JSON reporter captures them in test-results.
    if (pageErrors.length > 0) {
      // eslint-disable-next-line no-console -- diagnostic output for test failure
      console.log('page errors:', pageErrors);
    }
    if (consoleLogs.length > 0) {
      // eslint-disable-next-line no-console -- diagnostic output for test failure
      console.log('console logs:', consoleLogs.slice(-20));
    }

    expect(pageErrors, 'no page errors during drag-drop').toEqual([]);

    for (let i = 0; i < samples.length; i++) {
      expect(
        samples[i],
        `sample ${String(i)} (at t=${String((i + 1) * 100)} ms after drop) reverted`,
      ).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P9', 'P7', 'P8']);
    }

    expect(reorderBody).not.toBeNull();
    expect(reorderBody!.secrets).toEqual([
      realSecret, // P1
      'hs-8431-p2-secret',
      'hs-8431-p3-secret',
      'hs-8431-p4-secret',
      'hs-8431-p5-secret',
      'hs-8431-p6-secret',
      'hs-8431-p9-secret',
      'hs-8431-p7-secret',
      'hs-8431-p8-secret',
    ]);
  });

  // HS-8432 — the user observed two drop spots for every gap. Pre-fix
  // the indicator's X was computed independently for "after tab N"
  // (tab.right + 1) and "before tab N+1" (tab.left - 1), and with a
  // 4 px CSS gap between tabs those two positions ended up ~2 px
  // apart. As the cursor traversed the gap the indicator visibly
  // jumped. Post-fix the handler tracks a single insertion index per
  // gap and the indicator is centered in the gap, so both cursor
  // halves resolve to identical pixels.
  test('drop indicator stays put as cursor crosses a gap (HS-8432)', async ({ page, request }) => {
    const projects = await (await request.get('/api/projects')).json() as { secret: string }[];
    const realSecret = projects[0]?.secret ?? '';

    await page.route(/\/api\/projects(\?.*)?$/, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { name: 'Alpha', dataDir: '/tmp/hs-8432-alpha', secret: realSecret, ticketCount: 0 },
          { name: 'Beta',  dataDir: '/tmp/hs-8432-beta',  secret: 'hs-8432-beta-secret', ticketCount: 0 },
          { name: 'Gamma', dataDir: '/tmp/hs-8432-gamma', secret: 'hs-8432-gamma-secret', ticketCount: 0 },
        ]),
      });
    });

    await page.goto('/');
    const tabs = page.locator('.project-tab');
    await expect(tabs).toHaveCount(3);

    // Start a drag from Alpha so the indicator activates when we
    // dragover on the other tabs. dragSecret stays set until dragend.
    await page.evaluate(() => {
      const allTabs = document.querySelectorAll<HTMLElement>('.project-tab');
      const dt = new DataTransfer();
      allTabs[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });

    // Sweep cursor across the gap between Beta (tab 1) and Gamma
    // (tab 2). For each sample point we (a) trigger a dragover on the
    // tab the cursor is actually over and (b) capture the indicator's
    // resolved left position. Every sample whose underlying insertion
    // gap is "between Beta and Gamma" must yield the SAME left value.
    const samples = await page.evaluate(() => {
      const allTabs = document.querySelectorAll<HTMLElement>('.project-tab');
      const beta = allTabs[1];
      const gamma = allTabs[2];
      const betaRect = beta.getBoundingClientRect();
      const gammaRect = gamma.getBoundingClientRect();
      // Five cursor positions, all logically "between Beta and Gamma":
      //   - inside Beta's right half (just past Beta's midpoint)
      //   - at Beta's right edge
      //   - middle of the gap (not over either tab — no dragover fires)
      //   - at Gamma's left edge
      //   - inside Gamma's left half (just before Gamma's midpoint)
      const points: { tab: HTMLElement; clientX: number; label: string }[] = [
        { tab: beta,  clientX: betaRect.left + betaRect.width * 0.6,            label: 'beta-right-1' },
        { tab: beta,  clientX: betaRect.left + betaRect.width * 0.95,           label: 'beta-right-edge' },
        { tab: gamma, clientX: gammaRect.left + gammaRect.width * 0.05,         label: 'gamma-left-edge' },
        { tab: gamma, clientX: gammaRect.left + gammaRect.width * 0.4,          label: 'gamma-left-1' },
      ];
      const results: { label: string; left: string }[] = [];
      for (const { tab, clientX, label } of points) {
        const dt = new DataTransfer();
        tab.dispatchEvent(new DragEvent('dragover', {
          bubbles: true, cancelable: true, dataTransfer: dt,
          clientX, clientY: betaRect.top + betaRect.height / 2,
        }));
        const indicator = document.querySelector<HTMLElement>('.tab-drop-indicator');
        results.push({ label, left: indicator?.style.left ?? '' });
      }
      return results;
    });

    // Every sample on either side of the gap must place the indicator
    // at the same pixel column — that's the single-drop-spot contract.
    // Pre-fix the beta-right-* samples produced one value and the
    // gamma-left-* samples produced a different (~2 px-offset) value;
    // they would fail this equality assertion.
    expect(samples.length).toBe(4);
    const firstLeft = samples[0].left;
    expect(firstLeft).not.toBe('');
    for (const sample of samples) {
      expect(sample.left, `${sample.label} produced ${sample.left} (expected ${firstLeft})`).toBe(firstLeft);
    }

    // Cleanly end the drag so subsequent tests aren't poisoned.
    await page.evaluate(() => {
      const allTabs = document.querySelectorAll<HTMLElement>('.project-tab');
      allTabs[0].dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    });
  });
});
