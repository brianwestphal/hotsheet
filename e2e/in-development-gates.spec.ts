/**
 * HS-9411 (docs/124) — the Settings → Experimental → "In Development" section.
 *
 * The unit tests pin the pure helpers + the cache; this spec proves the parts that
 * only exist in the running app: the gated surfaces are absent by default, a
 * checkbox reveals them without a reload, and the value persists to
 * `settings.local.json` and NOT the shared `settings.json` (the whole point of the
 * `dev_` prefix — these must never be committed for the team).
 */
import { expect, test } from './coverage-fixture.js';

type Page = import('@playwright/test').Page;

const secretHeaders = (secret: string) => ({ 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret });

async function openExperimentalTab(page: Page): Promise<void> {
  // Opening Settings kicks off the Backups tab's snapshot-status fetch. A test that
  // reloads soon after would abort it and trip the HS-8435 console-error gate, so
  // arm the wait BEFORE the click (same pattern as e2e/commands.spec.ts).
  const snapSettled = page.waitForResponse(r => /\/api\/db\/snapshot-status/.test(r.url()), { timeout: 5000 }).catch(() => null);
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
  await page.locator('.settings-tab[data-tab="experimental"]').click();
  await expect(page.locator('.settings-tab-panel[data-panel="experimental"]')).toHaveClass(/active/);
  await snapSettled;
}

/** The In Development checkbox for a gate key. */
const gate = (page: Page, key: string) => page.locator(`.in-development-toggle[data-dev-key="${key}"]`);

test.describe('In Development gates (HS-9411)', () => {
  let secret = '';

  test.beforeEach(async ({ request }) => {
    const projects = await (await request.get('/api/projects')).json() as { secret: string }[];
    secret = projects[0]?.secret ?? '';
    expect(secret).not.toBe('');
    // Start from the default (all gates off) regardless of what ran before.
    await request.patch('/api/file-settings/layer', {
      headers: secretHeaders(secret),
      data: { layer: 'local', settings: { dev_parallel_workers: false, dev_remote_access: false, dev_tool_codex: false, dev_tool_antigravity: false } },
    });
  });

  test('the section renders one checkbox per gate, all off by default', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openExperimentalTab(page);

    const section = page.locator('.settings-section-in-development');
    await expect(section).toBeVisible();
    await expect(section.locator('.settings-in-development-note')).toContainText('at your own risk');

    const toggles = page.locator('.in-development-toggle');
    await expect(toggles).toHaveCount(7);
    for (let i = 0; i < 7; i++) await expect(toggles.nth(i)).not.toBeChecked();
  });

  test('Remote Access tab is hidden until its gate is on, and returns when enabled', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openExperimentalTab(page);

    const remoteTab = page.locator('#settings-tab-devices');
    await expect(remoteTab).toBeHidden();

    // Enabling applies immediately — no reload.
    await gate(page, 'dev_remote_access').check();
    await expect(remoteTab).toBeVisible();

    // …and unchecking hides it again.
    await gate(page, 'dev_remote_access').uncheck();
    await expect(remoteTab).toBeHidden();
  });

  test('a gate persists to settings.local.json and NOT the shared settings.json', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openExperimentalTab(page);

    await gate(page, 'dev_parallel_workers').check();

    const layered = async () => await (await request.get('/api/file-settings/layered', { headers: secretHeaders(secret) })).json() as {
      shared: Record<string, unknown>; local: Record<string, unknown>;
    };
    await expect.poll(async () => (await layered()).local.dev_parallel_workers, { timeout: 5000 }).toBe(true);
    // The load-bearing assertion: it must NOT be in the committed shared layer.
    expect((await layered()).shared.dev_parallel_workers).toBeUndefined();
  });

  test('the gate survives a reload', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openExperimentalTab(page);
    await gate(page, 'dev_remote_access').check();
    await expect(page.locator('#settings-tab-devices')).toBeVisible();

    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openExperimentalTab(page);
    await expect(gate(page, 'dev_remote_access')).toBeChecked();
    await expect(page.locator('#settings-tab-devices')).toBeVisible();
  });

  test('an in-development AI tool is absent from the dropdown until its gate is on', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openExperimentalTab(page);

    const optionCount = async (value: string) => await page.locator(`#ai-tool-select option[value="${value}"]:not([hidden])`).count();

    await page.locator('.settings-tab[data-tab="general"]').click();
    // Ungated tools are always offered; gated ones are not (this project's ai_tool
    // is unset, so no already-selected exception applies).
    await expect.poll(() => optionCount('claude'), { timeout: 5000 }).toBe(1);
    expect(await optionCount('cursor')).toBe(1);
    expect(await optionCount('codex')).toBe(0);
    expect(await optionCount('opencode')).toBe(0);

    // Enable just Codex — it appears, the others stay hidden.
    await page.locator('.settings-tab[data-tab="experimental"]').click();
    await gate(page, 'dev_tool_codex').check();
    await page.locator('#settings-close').click();
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible();
    await expect.poll(() => optionCount('codex'), { timeout: 5000 }).toBe(1);
    expect(await optionCount('opencode')).toBe(0);
  });

  // HS-9474 — the reported bug: enabling a tool's gate left its dropdown option
  // disabled until Settings was closed and reopened. Note the test ABOVE reopens
  // the dialog between the two assertions, which is precisely why it never caught
  // this — it encoded the workaround as the expected flow.
  test('enabling a tool gate enables its dropdown option WITHOUT reopening Settings', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openExperimentalTab(page);

    // Playwright treats any `<option>` in a closed `<select>` as not visible, so
    // assert the `hidden` ATTRIBUTE (as the test above does) rather than visibility.
    const shown = async () => await page.locator('#ai-tool-select option[value="antigravity"]:not([hidden])').count();
    const option = page.locator('#ai-tool-select option[value="antigravity"]');

    await page.locator('.settings-tab[data-tab="general"]').click();
    expect(await shown()).toBe(0);
    await expect(option).toBeDisabled();

    // Flip the gate and come straight back — no close, no reload.
    await page.locator('.settings-tab[data-tab="experimental"]').click();
    await gate(page, 'dev_tool_antigravity').check();
    await page.locator('.settings-tab[data-tab="general"]').click();

    await expect.poll(shown, { timeout: 5000 }).toBe(1);
    // Enabled + not hidden IS selectable — `disabled` is what blocks selection.
    // Deliberately NOT calling `selectOption` here: persisting `ai_tool` would leak
    // into the next test, where the docs/124 "already in use" exception keeps that
    // tool selectable and every gate assertion stops meaning what it says. (Found
    // exactly that way — these passed alone and failed in sequence, the option
    // labeled "— in development".)
    await expect(option).toBeEnabled();
  });

  test('turning a tool gate back off re-hides its option live', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openExperimentalTab(page);
    await gate(page, 'dev_tool_antigravity').check();

    const option = page.locator('#ai-tool-select option[value="antigravity"]');
    await page.locator('.settings-tab[data-tab="general"]').click();
    await expect(option).toBeEnabled();

    await page.locator('.settings-tab[data-tab="experimental"]').click();
    await gate(page, 'dev_tool_antigravity').uncheck();
    await page.locator('.settings-tab[data-tab="general"]').click();
    await expect(option).toBeDisabled();
  });

  test('a tool the project already uses stays selectable even with its gate off', async ({ page, request }) => {
    // Simulate the upgrade case: the project was already on codex before the gate existed.
    await request.patch('/api/file-settings', { headers: secretHeaders(secret), data: { ai_tool: 'codex' } });
    try {
      await page.goto('/');
      await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
      await page.locator('#settings-btn').click();
      await expect(page.locator('#settings-overlay')).toBeVisible();

      // Visible despite the gate being off, labeled so the state is legible, and
      // still the selected value — the project is NOT silently switched.
      const codex = page.locator('#ai-tool-select option[value="codex"]');
      await expect(codex).not.toHaveAttribute('hidden', /.*/, { timeout: 5000 });
      await expect(codex).toContainText('in development');
      await expect(page.locator('#ai-tool-select')).toHaveValue('codex');
      // A different gated tool is still hidden — the exception is scoped to the one in use.
      expect(await page.locator('#ai-tool-select option[value="opencode"]:not([hidden])').count()).toBe(0);
    } finally {
      await request.patch('/api/file-settings', { headers: secretHeaders(secret), data: { ai_tool: '' } });
    }
  });

  // HS-9473 — the reported bug: two Codex-specific GLOBAL settings stayed visible
  // in a project whose Codex gate was off. The gate mechanism was fine; the markup
  // simply never opted in via `data-dev-feature`, which no test of the mechanism
  // could have caught.
  test('Codex-specific settings stay hidden with the Codex gate off', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openExperimentalTab(page);
    await expect(gate(page, 'dev_tool_codex')).not.toBeChecked();
    await expect(page.locator('#settings-codex-app-server-enabled')).toBeHidden();
    await expect(page.locator('#settings-codex-model-b-terminals')).toBeHidden();
  });

  test('the Codex settings appear as soon as the gate is on, without a reload', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openExperimentalTab(page);
    await gate(page, 'dev_tool_codex').check();
    await expect(page.locator('#settings-codex-app-server-enabled')).toBeVisible();
    await expect(page.locator('#settings-codex-model-b-terminals')).toBeVisible();

    // ...and go away again when it is turned back off.
    await gate(page, 'dev_tool_codex').uncheck();
    await expect(page.locator('#settings-codex-app-server-enabled')).toBeHidden();
  });

  test('worker surfaces stay hidden with the parallel-workers gate off', async ({ page, request }) => {
    await request.post('/api/channel/enable', { headers: secretHeaders(secret) });
    try {
      await page.goto('/');
      await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
      // Channel enabled would normally reveal these two rows (HS-9039 / HS-9068);
      // the gate must win.
      await expect(page.locator('#sidebar-worker-actions')).toBeHidden();
      await expect(page.locator('#sidebar-worker-auto')).toBeHidden();
    } finally {
      await request.post('/api/channel/disable', { headers: secretHeaders(secret) });
    }
  });
});
