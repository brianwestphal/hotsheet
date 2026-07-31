/**
 * HS-9490 (docs/132 §132.5) — the AI-tool dropdown is now SERVER-RENDERED from the
 * plugin registry instead of a hand-maintained `<option>` list in `pages.tsx`.
 *
 * That makes a registry mistake a visible UI regression rather than a silent one, so
 * this pins the rendered result: the exact option set, in the declared order, with
 * `auto` first. A unit test over `listPlugins()` cannot catch a broken render — it would
 * pass against a `<select>` that emitted nothing.
 *
 * The docs/124 In-Development gating still runs client-side (`applyAiToolDevGating`),
 * because it depends on per-project gate settings and the currently-selected tool. So
 * the assertions below read the option VALUES including hidden ones, which is what the
 * registry actually controls; §124's own spec (`in-development-gates.spec.ts`) covers
 * which of them are selectable.
 */
import { expect, test } from './coverage-fixture.js';

/** `auto` (a resolution mode, not a plugin) then the registry order from
 *  `src/aiTools/registry.ts`. Update together, deliberately. */
const EXPECTED_VALUES = [
  'auto',
  'claude',
  'codex',
  'antigravity',
  'gemini',
  'opencode',
  'goose',
  'cursor',
  'copilot',
  'windsurf',
];

/** The FULL product names (`productName`), not the short busy-indicator labels. */
const EXPECTED_LABELS = [
  'Auto-detect (default)',
  'Claude Code',
  'Codex',
  'Antigravity',
  'Gemini CLI',
  'OpenCode',
  'Goose',
  'Cursor',
  'GitHub Copilot',
  'Windsurf',
];

test.describe('AI tool dropdown is generated from the plugin registry (HS-9490)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#settings-btn').click();
    await expect(page.locator('#ai-tool-select')).toBeAttached({ timeout: 5000 });
  });

  test('renders every registered tool, in registry order, with auto first', async ({ page }) => {
    const values = await page.locator('#ai-tool-select option').evaluateAll(
      opts => opts.map(o => (o as HTMLOptionElement).value),
    );
    expect(values).toEqual(EXPECTED_VALUES);
  });

  test('labels each option with the full product name', async ({ page }) => {
    const labels = await page.locator('#ai-tool-select option').evaluateAll(
      // `dataset.baseLabel` is the pristine label the gating filter stashes before it
      // may append "— in development"; fall back to the text for ungated options.
      opts => opts.map(o => (o as HTMLOptionElement).dataset.baseLabel ?? o.textContent),
    );
    expect(labels).toEqual(EXPECTED_LABELS);
  });

  test('the generated option values are the same vocabulary the setting stores', async ({ page, request }) => {
    // The failure a markup snapshot would miss: options that LOOK right but carry the
    // wrong `value` — rendering `productName` ("Claude Code") where the setting expects
    // an id ("claude") would display perfectly and break every read of `ai_tool`.
    //
    // Asserted WITHOUT writing: `in-development-gates.spec.ts` documents that persisting
    // `ai_tool` leaks into other tests, and the dropdown's own selection is enough — the
    // client sets it from the stored value, so if the vocabularies disagreed nothing
    // would be selected.
    const stored = (await request.get('/api/file-settings').then(r => r.json()) as { ai_tool?: string }).ai_tool;
    const expected = stored === undefined || stored === '' ? 'auto' : stored;

    await expect.poll(
      () => page.locator('#ai-tool-select').inputValue(),
      { timeout: 8000 },
    ).toBe(expected);
    expect(EXPECTED_VALUES).toContain(expected);
  });
});
