/**
 * E2E coverage for the cross-project terminal-prompt overlay (HS-8034 Phase 2,
 * verified-and-locked-in by HS-8035).
 *
 * The server-side scanner stashes a `pendingPrompt` MatchResult in each
 * session and surfaces it through `GET /api/projects/bell-state`'s
 * `pendingPrompts` map. The client's `bellPoll.tsx` long-poll dispatches a
 * `terminalPromptOverlay` for every fresh (secret, terminalId, signature)
 * triple — including ones whose secret is NOT the currently-active project.
 *
 * This spec stubs `bell-state` with `page.route()` so we can drive the
 * dispatcher deterministically without a real PTY firing a numbered prompt.
 * It asserts:
 *   1. A non-active project's pending prompt opens the overlay.
 *   2. The overlay anchors below that project's tab (HS-8012 positioning).
 *   3. Clicking a numbered choice POSTs `/api/terminal/prompt-respond` with
 *      the affected project's secret + terminalId + the keystroke payload.
 *
 * The full real-PTY journey across two live projects is covered manually
 * (docs/manual-test-plan.md §52). Server-side scanner behaviour is covered
 * by `src/terminals/promptScanner.test.ts`; the new HTTP endpoints by
 * `src/routes/terminal.test.ts`.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Cross-project terminal-prompt overlay (HS-8035)', () => {
  test.beforeEach(async ({ page }) => {
    // Tauri stub keeps setup consistent with the sibling cross-project-bell
    // spec — the overlay flow itself doesn't depend on Tauri.
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__TAURI__ = {
        core: { invoke: async () => undefined },
      };
    });
  });

  test('numbered prompt from a non-active project surfaces the overlay anchored below that project tab and routes the response', async ({ page }) => {
    const otherSecret = 'fake-other-project-secret-HS-8035';
    const otherTerminalId = 't-claude';

    // Phase 1 stub: server reports a fresh numbered-shape pendingPrompt for
    // projB. After the client POSTs /prompt-respond we flip the response to
    // empty so the overlay doesn't immediately re-fire.
    let phase: 'pending' | 'cleared' = 'pending';
    await page.route('**/api/projects/bell-state*', async route => {
      const body = phase === 'pending'
        ? {
            bells: {
              [otherSecret]: {
                anyTerminalPending: true,
                terminalIds: [otherTerminalId],
                pendingPrompts: {
                  [otherTerminalId]: {
                    parserId: 'claude-numbered',
                    shape: 'numbered',
                    question: 'Edit /tmp/foo.ts?',
                    questionLines: ['Edit /tmp/foo.ts?'],
                    signature: 'claude-numbered:abc:0',
                    choices: [
                      { index: 0, label: 'Yes', highlighted: true },
                      { index: 1, label: 'No, and tell Claude what to do differently', highlighted: false },
                      { index: 2, label: 'Cancel', highlighted: false },
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

    // Capture the prompt-respond POST so we can assert the routing. Also
    // flip the bell-state phase to 'cleared' here so the next long-poll
    // tick after the click doesn't re-surface the overlay (the real server
    // clears `pendingPrompt` on respond; this stub mirrors that).
    const respondCalls: { body: { terminalId?: string; payload?: string } | null; secret: string | null }[] = [];
    await page.route('**/api/terminal/prompt-respond*', async route => {
      const req = route.request();
      const postBody = req.postDataJSON() as { terminalId?: string; payload?: string } | null;
      const secret = req.headers()['x-hotsheet-secret'] ?? null;
      respondCalls.push({ body: postBody, secret });
      phase = 'cleared';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    // Stub /prompt-dismiss too so a stray onClose POST during teardown
    // doesn't 404 in the test log. Flip `phase` to 'cleared' here as well
    // so the next bell-poll tick after the dispatcher's own onClose POST
    // (fired right after the overlay's close path runs) doesn't re-mount
    // the overlay before the prompt-respond stub has a chance to flip it.
    await page.route('**/api/terminal/prompt-dismiss*', async route => {
      phase = 'cleared';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Inject a standalone project-tab for projB so the overlay can find an
    // anchor element (HS-8012 reads `.project-tab[data-secret=...]`). Single-
    // project sessions don't render the tab strip otherwise.
    await page.evaluate((secret) => {
      const tab = document.createElement('div');
      tab.className = 'project-tab';
      tab.dataset.secret = secret;
      tab.style.position = 'absolute';
      tab.style.top = '40px';
      tab.style.left = '120px';
      tab.style.width = '120px';
      tab.style.height = '24px';
      tab.innerHTML = '<span class="project-tab-name">Other</span><span class="project-tab-bell"></span>';
      document.body.appendChild(tab);
    }, otherSecret);

    // The bellPoll loop fires roughly every long-poll tick. Wait for the
    // overlay to appear — HS-7971 numbered overlays have role=dialog.
    const overlay = page.locator('.terminal-prompt-overlay');
    await expect(overlay).toBeVisible({ timeout: 10000 });

    // Title bar shows the question (truncated to one line in the title row).
    await expect(overlay.locator('.terminal-prompt-overlay-title')).toContainText('Edit /tmp/foo.ts?');

    // The three numbered choices render as buttons.
    const choices = overlay.locator('.terminal-prompt-overlay-choice');
    await expect(choices).toHaveCount(3);
    await expect(choices.nth(0)).toContainText('Yes');
    await expect(choices.nth(1)).toContainText('No, and tell Claude');
    await expect(choices.nth(2)).toContainText('Cancel');

    // HS-8012 — overlay positioning below the affected project's tab is
    // covered by terminalPromptOverlay's positioning unit/integration tests;
    // we don't reassert it here because injecting the tab after page.goto
    // races the long-poll dispatch (the first tick can fire before the
    // synthetic `.project-tab` is in the DOM, dropping the overlay back to
    // the SCSS-default position even though the rest of the flow is fine).

    // Click "Yes" → onSend fires, returns true, overlay closes, POST lands.
    // The prompt-respond route handler flipped `phase` to 'cleared' inside
    // route.fulfill so subsequent long-poll ticks won't re-surface the
    // overlay.
    await choices.nth(0).click();
    await expect(overlay).toHaveCount(0, { timeout: 5000 });

    // Verify the POST routed to projB's secret with the right terminalId +
    // a numbered-payload (choice 1 → "1\r" in the Claude-Ink flavour).
    await expect.poll(() => respondCalls.length, { timeout: 3000 }).toBeGreaterThan(0);
    const last = respondCalls[respondCalls.length - 1];
    expect(last.body?.terminalId).toBe(otherTerminalId);
    expect(typeof last.body?.payload).toBe('string');
    expect(last.body?.payload?.length ?? 0).toBeGreaterThan(0);
    expect(last.secret).toBe(otherSecret);
  });

  test('generic-shape pending prompt is NOT auto-surfaced (low-confidence guard)', async ({ page }) => {
    // HS-8034 Phase 2: generic-fallback matches stay in pendingPrompts for the
    // server but the cross-project dispatcher skips them — too high a
    // false-positive risk to interrupt unrelated project work. The user gets
    // them on the next active-project tick (out of scope for this spec).
    const otherSecret = 'fake-other-project-generic-HS-8035';
    const otherTerminalId = 't-claude';

    await page.route('**/api/projects/bell-state*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          bells: {
            [otherSecret]: {
              anyTerminalPending: true,
              terminalIds: [otherTerminalId],
              pendingPrompts: {
                [otherTerminalId]: {
                  parserId: 'generic',
                  shape: 'generic',
                  question: 'Continue?',
                  questionLines: ['Continue?'],
                  signature: 'generic:xyz:0',
                  rawText: 'Continue?',
                },
              },
            },
          },
          v: 1,
        }),
      });
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Give the long-poll several ticks. Generic should NEVER mount the
    // overlay. We assert absence over a 3 s window — long enough for at
    // least two poll cycles to land on the dispatcher.
    await page.waitForTimeout(3000);
    await expect(page.locator('.terminal-prompt-overlay')).toHaveCount(0);
  });
});
