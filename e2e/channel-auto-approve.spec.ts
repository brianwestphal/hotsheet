/**
 * E2E coverage for HS-8210 Phase C — implicit channel-rule creation in the
 * cross-project terminal-prompt overlay.
 *
 * Drives the dispatcher with a stubbed `bell-state` carrying a channel-
 * bearing numbered prompt (the parser would set `match.channel` from the
 * `Channels: <value>` line in production; here we fabricate it directly).
 * After the user clicks a numbered choice we assert the client wrote a
 * channel-keyed allow rule by capturing the PATCH `/api/file-settings`
 * call. The "Don't remember" path asserts the symmetric NEGATIVE — no
 * PATCH lands when the opt-out checkbox is ticked.
 *
 * Real PTY → real scanner → real bell-poll → real overlay → real allow-
 * rule write is covered by the Phase A / B unit tests + the manual test
 * plan (docs/manual-test-plan.md §52). This spec pins the new client-side
 * extras.dontRememberChannel passthrough + the appendAllowRule wiring.
 */
import { expect, test } from './coverage-fixture.js';

interface CapturedPatchBody {
  terminal_prompt_allow_rules?: Array<{
    parser_id: string;
    match_channel?: string;
    choice_index: number;
    question_hash: string;
  }>;
}

test.describe('Channel auto-approve — implicit rule creation (HS-8210 Phase C)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__TAURI__ = {
        core: { invoke: async () => undefined },
      };
    });
  });

  test('clicking a choice on a channel-bearing prompt writes a channel-keyed allow rule', async ({ page }) => {
    const otherSecret = 'fake-channel-project-secret-HS-8210';
    const otherTerminalId = 't-claude';

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
                    question: 'WARNING: Loading development channels',
                    questionLines: [
                      'WARNING: Loading development channels',
                      '',
                      'Channels: server:hotsheet-channel',
                    ],
                    signature: 'claude-numbered:abc:0',
                    channel: 'server:hotsheet-channel',
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

    await page.route('**/api/terminal/prompt-respond*', async route => {
      phase = 'cleared';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.route('**/api/terminal/prompt-dismiss*', async route => {
      phase = 'cleared';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    // Capture every PATCH /file-settings call so the test can assert the
    // rule body. GET passes through normally to the live server (returns
    // current settings, including any rules set in prior tests — typically
    // empty for a fresh data dir).
    const patchBodies: CapturedPatchBody[] = [];
    const patchSecrets: string[] = [];
    await page.route('**/api/file-settings*', async route => {
      const req = route.request();
      if (req.method() === 'PATCH') {
        const body = req.postDataJSON() as CapturedPatchBody | null;
        if (body !== null) patchBodies.push(body);
        const secret = req.headers()['x-hotsheet-secret'] ?? '';
        patchSecrets.push(secret);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }
      // GET — fabricate an empty existing rule list so appendAllowRule's
      // dedupe logic doesn't accidentally collapse the channel rule.
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Inject the project tab so the overlay's HS-8012 anchoring finds a target.
    await page.evaluate((secret) => {
      const tab = document.createElement('div');
      tab.className = 'project-tab';
      tab.dataset.secret = secret;
      tab.style.position = 'absolute';
      tab.style.top = '40px';
      tab.style.left = '120px';
      tab.style.width = '120px';
      tab.style.height = '24px';
      document.body.appendChild(tab);
    }, otherSecret);

    const overlay = page.locator('.terminal-prompt-overlay');
    await expect(overlay).toBeVisible({ timeout: 10000 });

    // Channel footer is present; always-allow checkbox is hidden.
    await expect(overlay.locator('.terminal-prompt-overlay-channel-rule-row')).toBeVisible();
    await expect(overlay.locator('.terminal-prompt-overlay-allow-rule-row')).toHaveCount(0);
    await expect(overlay.locator('.terminal-prompt-overlay-channel-rule-row')).toContainText('auto-approved next time');

    // Click choice 0 → the dispatcher's onSend wrapper writes a channel-
    // keyed rule via appendAllowRule(rule, secret).
    await overlay.locator('.terminal-prompt-overlay-choice[data-choice-index="0"]').click();
    await expect(overlay).toHaveCount(0, { timeout: 5000 });

    // The PATCH /file-settings carried the channel-keyed rule.
    await expect.poll(() => patchBodies.length, { timeout: 3000 }).toBeGreaterThan(0);
    const lastBody = patchBodies[patchBodies.length - 1];
    const rules = lastBody.terminal_prompt_allow_rules ?? [];
    expect(rules.length).toBeGreaterThan(0);
    const channelRule = rules.find(r => r.match_channel === 'server:hotsheet-channel');
    expect(channelRule).toBeDefined();
    expect(channelRule?.parser_id).toBe('claude-numbered');
    expect(channelRule?.choice_index).toBe(0);
    expect(channelRule?.question_hash).toBe('');

    // Secret routes to the originating project (HS-8057).
    expect(patchSecrets[patchSecrets.length - 1]).toBe(otherSecret);
  });

  test('"Don\'t remember" opt-out skips the implicit channel-rule write', async ({ page }) => {
    const otherSecret = 'fake-channel-project-dontremember-HS-8210';
    const otherTerminalId = 't-claude';

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
                    question: 'WARNING: Loading development channels',
                    questionLines: ['WARNING: Loading development channels', '', 'Channels: server:hotsheet-channel'],
                    signature: 'claude-numbered:abc:0',
                    channel: 'server:hotsheet-channel',
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
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    await page.route('**/api/terminal/prompt-respond*', async route => {
      phase = 'cleared';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.route('**/api/terminal/prompt-dismiss*', async route => {
      phase = 'cleared';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    const patchCount = { value: 0 };
    await page.route('**/api/file-settings*', async route => {
      const req = route.request();
      if (req.method() === 'PATCH') patchCount.value += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.evaluate((secret) => {
      const tab = document.createElement('div');
      tab.className = 'project-tab';
      tab.dataset.secret = secret;
      tab.style.position = 'absolute';
      tab.style.top = '40px';
      tab.style.left = '120px';
      tab.style.width = '120px';
      tab.style.height = '24px';
      document.body.appendChild(tab);
    }, otherSecret);

    const overlay = page.locator('.terminal-prompt-overlay');
    await expect(overlay).toBeVisible({ timeout: 10000 });

    // Tick the opt-out, then click choice 0.
    await overlay.locator('.terminal-prompt-overlay-channel-dont-remember').check();
    await overlay.locator('.terminal-prompt-overlay-choice[data-choice-index="0"]').click();
    await expect(overlay).toHaveCount(0, { timeout: 5000 });

    // Give the dispatcher's microtasks time to settle. No PATCH should
    // ever fire — the implicit-create gate read `dontRememberChannel === true`.
    await page.waitForTimeout(800);
    expect(patchCount.value).toBe(0);
  });
});
