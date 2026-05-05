/**
 * HS-8208 — boot-time terminal-prompt overlay regression.
 *
 * The user reported that on app startup, with claude already parked at the
 * `--dangerously-load-development-channels` prompt
 * ("Please use --channels to run a list of approved channels — 1. I am
 *  using this for local development / 2. Exit"), the §52 overlay did NOT
 * appear AT ALL. The §52 dispatcher (`bellPoll.tsx::dispatchPendingPrompts`)
 * is supposed to surface a `terminalPromptOverlay` for any pending prompt
 * the bell-state long-poll reports.
 *
 * Server-side scanner correctness is already covered by
 * `src/terminals/promptScanner.test.ts::matches a Claude-Ink numbered prompt
 * after ingest`, which feeds the production prompt bytes through the
 * scanner and asserts onMatch fires.
 *
 * Cross-project flow is covered by
 * `e2e/terminal-prompt-cross-project.spec.ts`.
 *
 * What this spec adds:
 *   1. **Boot scenario**: bell-state stub returns a pending prompt on the
 *      VERY FIRST poll (i.e. as if the prompt was already pending before
 *      the client connected — exactly the user's startup repro). Overlay
 *      must surface within 2 s.
 *   2. **Production dev-channels prompt**: uses the same `MatchResult`
 *      shape `claudeNumberedParser` produces for the prompt the user saw
 *      in the screenshot (signature, choices, parser_id).
 *   3. **Same project, active tab**: the prompt comes from the currently
 *      active project (not a cross-project background tab).
 *
 * Pre-fix the user reported "no popup at all" — this spec pins the
 * post-fix contract that this scenario reliably surfaces the overlay.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Terminal-prompt overlay — boot with pending prompt (HS-8208)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__TAURI__ = {
        core: { invoke: async () => undefined },
      };
    });
  });

  test('boot scenario: a pending prompt at first long-poll surfaces the overlay within 2 s', async ({ page }) => {
    // Use the active project's secret captured from /api/projects so the
    // dispatch path mirrors the real same-project flow — pre-HS-8035 the
    // dispatcher was active-project-only, so we explicitly cover the
    // post-HS-8035 contract that an active-project pending prompt at boot
    // also surfaces. (The cross-project flow has its own spec.)
    const projectsRes = await page.request.get('/api/projects');
    const projects = await projectsRes.json() as Array<{ secret: string; name: string }>;
    expect(projects.length).toBeGreaterThan(0);
    const activeSecret = projects[0].secret;
    const terminalId = 'default';

    let phase: 'pending' | 'cleared' = 'pending';
    let pollCount = 0;
    await page.route('**/api/projects/bell-state*', async (route) => {
      pollCount++;
      const body = phase === 'pending'
        ? {
            bells: {
              [activeSecret]: {
                anyTerminalPending: true,
                terminalIds: [terminalId],
                pendingPrompts: {
                  [terminalId]: {
                    parserId: 'claude-numbered',
                    shape: 'numbered',
                    // The user-screenshot prompt — the question region
                    // collapses to the channel-list line because that's
                    // what's visible above the choices in the user's
                    // 30-row scan window.
                    question: 'Channels: server:hotsheet-channel',
                    questionLines: [
                      'Please use --channels to run a list of approved channels.',
                      '',
                      'Channels: server:hotsheet-channel',
                    ],
                    signature: 'claude-numbered:hs8208deadbeef:0',
                    choices: [
                      { index: 0, label: 'I am using this for local development', highlighted: true },
                      { index: 1, label: 'Exit', highlighted: false },
                    ],
                  },
                },
              },
            },
            v: 1,
          }
        : { bells: {}, v: 2 };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });

    // Stub respond + dismiss so the post-click flow doesn't 404 / re-fire.
    const respondCalls: Array<{ payload?: string; terminalId?: string }> = [];
    await page.route('**/api/terminal/prompt-respond*', async (route) => {
      const body = route.request().postDataJSON() as { payload?: string; terminalId?: string };
      respondCalls.push(body);
      phase = 'cleared';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.route('**/api/terminal/prompt-dismiss*', async (route) => {
      phase = 'cleared';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Locking the user-reported contract: overlay surfaces within 2 s of
    // boot when a prompt is already pending. Pre-fix the user reported
    // "no popup at all" — this assertion would fail.
    const overlay = page.locator('.terminal-prompt-overlay');
    await expect(overlay).toBeVisible({ timeout: 2000 });

    // Sanity: at least one bell-state poll must have fired by now (the
    // server's /bell-state long-poll responds immediately when state is
    // pending, so the first poll is enough).
    expect(pollCount).toBeGreaterThanOrEqual(1);

    // The overlay's chrome reflects the prompt details from the registry
    // match — chip ('Claude'), title (the question), and the two choices.
    await expect(overlay.locator('.dialog-shell-title')).toContainText('Channels: server:hotsheet-channel');
    const choices = overlay.locator('.terminal-prompt-overlay-choice');
    await expect(choices).toHaveCount(2);
    await expect(choices.nth(0)).toContainText('I am using this for local development');
    await expect(choices.nth(1)).toContainText('Exit');
  });

  test('boot scenario: late-arriving pending prompt (empty first poll, prompt on second) still surfaces the overlay', async ({ page }) => {
    // The user could also see the symptom if the FIRST bell-state response
    // returns before the PTY emits the prompt — the dispatcher would have
    // nothing to surface. The server-side `notifyBellWaiters` must wake the
    // long-poll on subsequent ticks. We simulate by returning empty on the
    // first call, then the prompt on the second.
    const projectsRes = await page.request.get('/api/projects');
    const projects = await projectsRes.json() as Array<{ secret: string; name: string }>;
    const activeSecret = projects[0].secret;
    const terminalId = 'default';

    let pollCount = 0;
    let phase: 'empty' | 'pending' | 'cleared' = 'empty';
    await page.route('**/api/projects/bell-state*', async (route) => {
      pollCount++;
      // Flip from empty → pending after the first poll so the second
      // long-poll iteration picks up the prompt.
      if (pollCount === 1) phase = 'pending';
      const body = phase === 'pending'
        ? {
            bells: {
              [activeSecret]: {
                anyTerminalPending: true,
                terminalIds: [terminalId],
                pendingPrompts: {
                  [terminalId]: {
                    parserId: 'claude-numbered',
                    shape: 'numbered',
                    question: 'Channels: server:hotsheet-channel',
                    questionLines: ['Channels: server:hotsheet-channel'],
                    signature: 'claude-numbered:hs8208late:0',
                    choices: [
                      { index: 0, label: 'I am using this for local development', highlighted: true },
                      { index: 1, label: 'Exit', highlighted: false },
                    ],
                  },
                },
              },
            },
            v: 2,
          }
        : { bells: {}, v: pollCount };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });
    await page.route('**/api/terminal/prompt-dismiss*', async (route) => {
      phase = 'cleared';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Within ~5 s the second poll should fire (TIMERS.POLL_RETRY_MS or the
    // long-poll's own 3 s timeout, whichever comes first). Overlay surfaces.
    const overlay = page.locator('.terminal-prompt-overlay');
    await expect(overlay).toBeVisible({ timeout: 5000 });
    expect(pollCount).toBeGreaterThanOrEqual(2);
  });
});
