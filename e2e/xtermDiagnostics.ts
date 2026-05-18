/**
 * HS-8421 — CI-side diagnostic logging for the 5 terminal-related e2e
 * tests that fail on the GH Actions ubuntu-latest runner but pass on
 * macOS / Docker Linux. The failures all converge on the same shape:
 * the xterm buffer doesn't contain the script's `printf` output (often
 * shows only `^L` or empty). Without the underlying buffer dump, the
 * Playwright report just says "expected to contain banana, found
 * <screen text>" — which depending on the truncation of the locator
 * report may not include enough to diagnose.
 *
 * `expectXtermContainsText` wraps `expect(locator).toContainText`. On
 * success it's a strict no-op extra. On failure it captures:
 *   - The visible `.xterm-rows` and `.xterm-screen` textContent
 *   - The viewport size (cols × rows) via xterm's helper textarea attrs
 *   - The row child count (proxy for whether the renderer is mounted)
 * — and attaches the dump to the Playwright test result via
 * `testInfo.attach` so the HTML report on CI shows it inline. Also
 * embeds the dump in the thrown error message so the headline failure
 * line in the runner's log is self-contained.
 *
 * The helper does not change behavior on a passing run (the wrapping
 * `try` only catches when the underlying `expect` throws), so wiring it
 * into a previously-passing test is safe.
 *
 * Sweep 6 (commit bac041c) used a similar `page.evaluate` dump to root-
 * cause an earlier `^L`-only failure; that fix shipped without leaving
 * the diagnostic in place. HS-8421's residual 5 failures depend on the
 * GH runner host environment specifically — local Linux Docker doesn't
 * reproduce — so the diagnostic needs to live in-tree to surface on the
 * next CI failure rather than being a one-shot investigation tool.
 */
import { expect, type Locator, type TestInfo } from '@playwright/test';

export interface XtermDumpOptions {
  /** Same as Playwright's `toContainText`. Defaults to 8000 ms — matches
   *  the existing assertion sites in `terminal-search.spec.ts` etc. */
  timeout?: number;
  /** Optional `testInfo` so the helper can `attach` the dump to the
   *  Playwright report. When omitted (some legacy callsites that don't
   *  thread testInfo through), the dump is still embedded in the
   *  thrown error message — just not as a separate attachment. */
  testInfo?: TestInfo;
  /** Optional label to disambiguate the attachment when multiple
   *  assertions in one test invoke this helper. Falls back to the
   *  expected text so the report is still readable without one. */
  label?: string;
}

interface XtermDump {
  rows: string;
  screen: string;
  rowChildCount: number;
  cols: number;
  rows_: number;
}

async function dumpXtermFromPane(pane: Locator): Promise<XtermDump> {
  return await pane.evaluate((el): XtermDump => {
    const rowsEl = el.querySelector('.xterm-rows');
    const screenEl = el.querySelector('.xterm-screen');
    const helperEl = el.querySelector('.xterm-helper-textarea');
    const cols = helperEl !== null ? parseInt(helperEl.getAttribute('aria-colcount') ?? '0', 10) : 0;
    const rows_ = helperEl !== null ? parseInt(helperEl.getAttribute('aria-rowcount') ?? '0', 10) : 0;
    return {
      rows: rowsEl?.textContent ?? '<no .xterm-rows>',
      screen: screenEl?.textContent ?? '<no .xterm-screen>',
      rowChildCount: rowsEl?.children.length ?? -1,
      cols,
      rows_,
    };
  });
}

/**
 * Assert that the xterm at `pane.locator('.xterm-screen')` contains
 * `expectedText`. Mirrors `expect(...).toContainText(...)` on success;
 * on failure adds an HS-8421 buffer dump to both the thrown error and
 * (when `testInfo` is provided) the Playwright report.
 */
export async function expectXtermContainsText(
  pane: Locator,
  expectedText: string | RegExp,
  options: XtermDumpOptions = {},
): Promise<void> {
  const { timeout = 8000, testInfo, label } = options;
  try {
    await expect(pane.locator('.xterm-screen')).toContainText(expectedText, { timeout });
  } catch (err) {
    const dump = await dumpXtermFromPane(pane).catch(() => null);
    const lines: string[] = [];
    const expectedRendered = expectedText instanceof RegExp ? expectedText.toString() : `"${expectedText}"`;
    lines.push(`[HS-8421] expectXtermContainsText(${expectedRendered}) failed.`);
    if (dump === null) {
      lines.push('  (could not dump xterm buffer — pane locator unreachable)');
    } else {
      lines.push(`  viewport: ${String(dump.cols)} cols × ${String(dump.rows_)} rows`);
      lines.push(`  .xterm-rows children: ${String(dump.rowChildCount)}`);
      lines.push(`  .xterm-rows textContent: ${JSON.stringify(dump.rows.slice(0, 2000))}`);
      lines.push(`  .xterm-screen textContent: ${JSON.stringify(dump.screen.slice(0, 2000))}`);
    }
    const dumpMessage = lines.join('\n');
    if (testInfo !== undefined) {
      const attachmentLabel = label ?? (expectedText instanceof RegExp ? expectedText.source : expectedText);
      await testInfo.attach(
        `xterm-dump-${attachmentLabel}`,
        { body: dumpMessage, contentType: 'text/plain' },
      );
    }
    const original = err instanceof Error ? err.message : String(err);
    throw new Error(`${dumpMessage}\n--- underlying assertion error ---\n${original}`);
  }
}
