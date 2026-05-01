// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { evaluateQuitDecision, type QuitSummary, showQuitConfirmDialog } from './quitConfirm.js';
import { _getTermForTesting, _inspectStackForTesting, _resetForTesting, entryCount } from './terminalCheckout.js';

function project(
  name: string,
  confirmMode: 'always' | 'never' | 'with-non-exempt-processes',
  entries: Array<{ label: string; cmd: string; isExempt: boolean; isShell?: boolean; theme?: string }>,
  opts?: { terminalDefault?: { theme?: string; fontFamily?: string; fontSize?: number } },
) {
  const proj: {
    secret: string;
    name: string;
    confirmMode: typeof confirmMode;
    entries: Array<{ terminalId: string; label: string; foregroundCommand: string; isShell: boolean; isExempt: boolean; theme?: string }>;
    terminalDefault?: { theme?: string; fontFamily?: string; fontSize?: number };
  } = {
    secret: `secret-${name}`,
    name,
    confirmMode,
    entries: entries.map(e => {
      const out: { terminalId: string; label: string; foregroundCommand: string; isShell: boolean; isExempt: boolean; theme?: string } = {
        terminalId: e.label,
        label: e.label,
        foregroundCommand: e.cmd,
        isShell: e.isShell ?? false,
        isExempt: e.isExempt,
      };
      if (e.theme !== undefined) out.theme = e.theme;
      return out;
    }),
  };
  if (opts?.terminalDefault !== undefined) proj.terminalDefault = opts.terminalDefault;
  return proj;
}

describe('evaluateQuitDecision (HS-7596 / §37.5)', () => {
  it('returns shouldPrompt:false when there are no projects', () => {
    const summary: QuitSummary = { projects: [] };
    expect(evaluateQuitDecision(summary)).toEqual({ shouldPrompt: false, contributing: [] });
  });

  it('returns shouldPrompt:false when every project is on never', () => {
    const summary: QuitSummary = {
      projects: [
        project('A', 'never', [{ label: 'claude', cmd: 'claude', isExempt: false }]),
        project('B', 'never', []),
      ],
    };
    expect(evaluateQuitDecision(summary).shouldPrompt).toBe(false);
  });

  it('always-mode fires the prompt even with no entries', () => {
    const summary: QuitSummary = {
      projects: [project('A', 'always', [])],
    };
    const result = evaluateQuitDecision(summary);
    expect(result.shouldPrompt).toBe(true);
    expect(result.contributing).toHaveLength(0); // no entries means nothing to display
  });

  it('always-mode shows ALL alive entries (including shell-only and exempt)', () => {
    const summary: QuitSummary = {
      projects: [
        project('A', 'always', [
          { label: 'idle', cmd: 'zsh', isExempt: true, isShell: true },
          { label: 'editor', cmd: 'less', isExempt: true },
          { label: 'work', cmd: 'claude', isExempt: false },
        ]),
      ],
    };
    const result = evaluateQuitDecision(summary);
    expect(result.shouldPrompt).toBe(true);
    expect(result.contributing).toHaveLength(1);
    expect(result.contributing[0].entries.map(e => e.label)).toEqual(['idle', 'editor', 'work']);
  });

  it('with-non-exempt-processes fires only when at least one entry is non-exempt', () => {
    const summary: QuitSummary = {
      projects: [
        project('idle-shell-only', 'with-non-exempt-processes', [
          { label: 'a', cmd: 'zsh', isExempt: true, isShell: true },
        ]),
      ],
    };
    expect(evaluateQuitDecision(summary).shouldPrompt).toBe(false);
  });

  it('with-non-exempt-processes filters the displayed entries to non-exempt only', () => {
    const summary: QuitSummary = {
      projects: [
        project('mix', 'with-non-exempt-processes', [
          { label: 'idle', cmd: 'zsh', isExempt: true, isShell: true },
          { label: 'htop', cmd: 'htop', isExempt: true },
          { label: 'work', cmd: 'claude', isExempt: false },
        ]),
      ],
    };
    const result = evaluateQuitDecision(summary);
    expect(result.shouldPrompt).toBe(true);
    expect(result.contributing).toHaveLength(1);
    expect(result.contributing[0].entries.map(e => e.label)).toEqual(['work']);
  });

  it('never-mode contributes its alive entries to the displayed list when ANOTHER project triggers the prompt', () => {
    const summary: QuitSummary = {
      projects: [
        project('A', 'always', []),
        project('B', 'never', [
          { label: 'b-claude', cmd: 'claude', isExempt: false },
          { label: 'b-shell', cmd: 'zsh', isExempt: true, isShell: true },
        ]),
      ],
    };
    const result = evaluateQuitDecision(summary);
    expect(result.shouldPrompt).toBe(true);
    // 'never' contributes ALL its entries (since the user wants to see what
    // they're killing across every project) — both shell + non-shell.
    expect(result.contributing).toHaveLength(1);
    expect(result.contributing[0].entries.map(e => e.label)).toEqual(['b-claude', 'b-shell']);
  });

  it('multi-project: with-non-exempt-processes triggers + never lists everything alive', () => {
    const summary: QuitSummary = {
      projects: [
        project('A', 'with-non-exempt-processes', [
          { label: 'a-work', cmd: 'claude', isExempt: false },
        ]),
        project('B', 'never', [
          { label: 'b-shell', cmd: 'zsh', isExempt: true, isShell: true },
        ]),
        project('C', 'with-non-exempt-processes', [
          { label: 'c-idle', cmd: 'zsh', isExempt: true, isShell: true },
        ]),
      ],
    };
    const result = evaluateQuitDecision(summary);
    expect(result.shouldPrompt).toBe(true);
    expect(result.contributing).toHaveLength(2);
    // A appears with its non-exempt entry only.
    expect(result.contributing[0].name).toBe('A');
    expect(result.contributing[0].entries.map(e => e.label)).toEqual(['a-work']);
    // B (never) appears with all its entries.
    expect(result.contributing[1].name).toBe('B');
    expect(result.contributing[1].entries.map(e => e.label)).toEqual(['b-shell']);
    // C (with-non-exempt) is NOT in the list because it has no non-exempt entries.
  });

  it('omits projects from the contributing list when they have no entries to display', () => {
    const summary: QuitSummary = {
      projects: [
        project('A', 'always', []),
        project('B', 'with-non-exempt-processes', [
          { label: 'idle', cmd: 'zsh', isExempt: true, isShell: true },
        ]),
        project('C', 'with-non-exempt-processes', [
          { label: 'work', cmd: 'claude', isExempt: false },
        ]),
      ],
    };
    const result = evaluateQuitDecision(summary);
    expect(result.shouldPrompt).toBe(true);
    expect(result.contributing.map(p => p.name)).toEqual(['C']);
  });
});

/**
 * HS-8041 / §54.5.2 — quit-confirm preview pane migrated to
 * `terminalCheckout`. The dialog auto-selects the first row on mount
 * which fires a `checkout(...)`. Every subsequent row click must
 * release the prior checkout BEFORE pushing the new one (cancel-then-
 * checkout ordering) so the stack never briefly holds two handles
 * pointing at the same `mountInto` element.
 *
 * happy-dom doesn't provide a real WebSocket — the checkout module
 * falls back to `ws=null` in the constructor (the typeof-undefined
 * short-circuit) so we can drive the stack semantics without a live
 * socket.
 */
describe('quit-confirm preview pane checkout (HS-8041 §54.5.2)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    _resetForTesting();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    _resetForTesting();
    // Drop any leaked overlay so the next test boots clean.
    document.querySelectorAll('.quit-confirm-overlay').forEach(el => el.remove());
  });

  function build3Rows() {
    return [
      project('proj-A', 'always', [
        { label: 'a-claude', cmd: 'claude', isExempt: false },
      ]),
      project('proj-B', 'always', [
        { label: 'b-claude', cmd: 'claude', isExempt: false },
        { label: 'b-htop', cmd: 'htop', isExempt: true },
      ]),
    ];
  }

  it('auto-selects the first row on mount: 1 entry, stack depth 1, key matches first row', () => {
    void showQuitConfirmDialog(build3Rows());
    // The auto-select fires synchronously in mount path, but the
    // overlay only appends to body just before that. Read the stack
    // directly — there's no timing window because `checkout` is sync.
    const snap = _inspectStackForTesting();
    expect(snap).toHaveLength(1);
    expect(snap[0].key).toBe('secret-proj-A::a-claude');
    expect(snap[0].stackDepth).toBe(1);
    // Cleanup: click cancel so the dialog tear-down releases the handle.
    document.querySelector<HTMLButtonElement>('.quit-confirm-btn-cancel')?.click();
  });

  it('row swap releases the prior checkout BEFORE starting the new one (no stack wedge)', () => {
    void showQuitConfirmDialog(build3Rows());
    const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('.quit-confirm-row'));
    expect(rows).toHaveLength(3); // a-claude, b-claude, b-htop

    // Initial state from auto-select: only the first row's entry exists.
    expect(_inspectStackForTesting().map(s => s.key)).toEqual(['secret-proj-A::a-claude']);

    // Click row 2 (b-claude). Cancel-then-checkout: A's handle releases
    // (entry disposed because it was the only consumer), then B's
    // checkout creates a fresh entry. Final state: 1 entry, key=B.
    rows[1].click();
    let snap = _inspectStackForTesting();
    expect(snap).toHaveLength(1);
    expect(snap[0].key).toBe('secret-proj-B::b-claude');
    expect(snap[0].stackDepth).toBe(1);

    // Click row 3 (b-htop) immediately. Same cancel-then-checkout
    // sequence. Final state: 1 entry, key=b-htop.
    rows[2].click();
    snap = _inspectStackForTesting();
    expect(snap).toHaveLength(1);
    expect(snap[0].key).toBe('secret-proj-B::b-htop');
    expect(snap[0].stackDepth).toBe(1);

    // Cleanup.
    document.querySelector<HTMLButtonElement>('.quit-confirm-btn-cancel')?.click();
  });

  it('rapid row clicks never leave a stale entry behind (the HS-8041 race regression)', () => {
    void showQuitConfirmDialog(build3Rows());
    const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('.quit-confirm-row'));

    // Three fast clicks in a row. Pre-fix (or with the wrong release
    // order) this would briefly leave 2 entries in the map mid-burst —
    // checkout's LIFO stack would push the new handle before the old
    // one cleared. Cancel-then-checkout keeps `entryCount()` at 1
    // throughout, with the latest-clicked row always winning.
    rows[1].click();
    rows[2].click();
    rows[0].click();
    expect(entryCount()).toBe(1);
    expect(_inspectStackForTesting()[0].key).toBe('secret-proj-A::a-claude');

    document.querySelector<HTMLButtonElement>('.quit-confirm-btn-cancel')?.click();
  });

  it('dialog dismiss releases the live checkout (entry disposed, no leaked entry)', () => {
    const promise = showQuitConfirmDialog(build3Rows());
    expect(entryCount()).toBe(1);

    // Cancel via the button.
    document.querySelector<HTMLButtonElement>('.quit-confirm-btn-cancel')?.click();
    expect(entryCount()).toBe(0);

    return expect(promise).resolves.toEqual({ outcome: 'cancel', dontAskAgain: false });
  });

  it('Quit Anyway also releases the checkout on dismiss', () => {
    const promise = showQuitConfirmDialog(build3Rows());
    expect(entryCount()).toBe(1);

    document.querySelector<HTMLButtonElement>('.quit-confirm-btn-danger')?.click();
    expect(entryCount()).toBe(0);

    return expect(promise).resolves.toEqual({ outcome: 'proceed', dontAskAgain: false });
  });
});

/**
 * HS-8058 / HS-8059 follow-up — the quit-confirm preview pane must
 * paint its container bg to match the configured xterm theme background
 * so the sub-cell slop around the canvas (the right + bottom gutter
 * where `cols * cellW` / `rows * cellH` doesn't fully cover the pane
 * content area) reads as part of the terminal rather than as the
 * contrasting gray pane the user reported as "text poking out of
 * terminal bounds".
 *
 * HS-8058's original implementation read the bg from the live xterm
 * (`currentCheckout.term.options.theme.background`), which only worked
 * when ANOTHER consumer (the drawer pane) had already mounted the
 * terminal and run `applyAppearanceToTerm` against it. When the user
 * opened the quit dialog before the drawer ever attached, the read
 * returned undefined and the bg fell back to gray — the user's
 * "inconsistent" report (5/1, 12:59). The HS-8059 follow-up resolves
 * the bg synchronously from server-supplied per-entry appearance
 * (`/api/projects/quit-summary` payload's `theme` / `terminalDefault`
 * fields) so the gutter paints deterministically regardless of
 * checkout order.
 */
describe('quit-confirm preview pane theme-bg cascade (HS-8058 / HS-8059)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    _resetForTesting();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    _resetForTesting();
    document.querySelectorAll('.quit-confirm-overlay').forEach(el => el.remove());
  });

  it('paints the preview bg from the per-entry theme override on row select', () => {
    // The auto-selected row's `theme: 'dracula'` resolves to bg
    // `#282a36` via `resolveAppearance` + `resolveAppearanceBackground`
    // — applied synchronously from the QuitSummary payload, no
    // dependency on `term.options.theme` being set by another consumer.
    const proj = project('proj-A', 'always', [
      { label: 'a-claude', cmd: 'claude', isExempt: false, theme: 'dracula' },
    ]);

    void showQuitConfirmDialog([proj]);

    const preview = document.querySelector<HTMLElement>('.quit-confirm-detail-preview');
    expect(preview).not.toBeNull();
    expect(preview!.style.background).toBe('#282a36'); // dracula bg #282a36

    // Sanity: the term has been checked out (the dialog auto-selected
    // the only row and pushed a checkout for it).
    const term = _getTermForTesting('secret-proj-A', 'a-claude');
    expect(term).not.toBeNull();

    document.querySelector<HTMLButtonElement>('.quit-confirm-btn-cancel')?.click();
  });

  it('falls back to project terminalDefault when the entry has no theme override', () => {
    const proj = project(
      'proj-A',
      'always',
      [{ label: 'a-claude', cmd: 'claude', isExempt: false }],
      { terminalDefault: { theme: 'github-dark' } },
    );
    void showQuitConfirmDialog([proj]);

    const preview = document.querySelector<HTMLElement>('.quit-confirm-detail-preview');
    expect(preview!.style.background).toBe('#0d1117'); // github-dark bg #0d1117

    document.querySelector<HTMLButtonElement>('.quit-confirm-btn-cancel')?.click();
  });

  it('regression — does NOT depend on term.options.theme being set by another consumer (HS-8059)', () => {
    // Pre-fix this test would have failed: the dialog's checkout
    // creates a fresh xterm, no other consumer ever ran
    // `applyAppearanceToTerm` against it, so `term.options.theme` was
    // undefined and the inline bg stayed empty. Post-fix the bg is
    // resolved from the server-supplied `theme` field synchronously.
    const proj = project('proj-A', 'always', [
      { label: 'a-claude', cmd: 'claude', isExempt: false, theme: 'solarized-dark' },
    ]);
    void showQuitConfirmDialog([proj]);

    const preview = document.querySelector<HTMLElement>('.quit-confirm-detail-preview');
    expect(preview!.style.background).toBe('#002b36'); // solarized-dark bg #002b36
    // Live xterm's theme is whatever the term defaults to (no consumer
    // touched it) — the bg-paint path no longer reads from it.
    const term = _getTermForTesting('secret-proj-A', 'a-claude');
    expect(term).not.toBeNull();

    document.querySelector<HTMLButtonElement>('.quit-confirm-btn-cancel')?.click();
  });

  it('updates the bg when the user switches rows to a terminal with a different theme', () => {
    const proj = project('proj-A', 'always', [
      { label: 'a-claude', cmd: 'claude', isExempt: false, theme: 'dracula' },
      { label: 'a-htop', cmd: 'htop', isExempt: true, theme: 'github-dark' },
    ]);

    void showQuitConfirmDialog([proj]);

    const preview = document.querySelector<HTMLElement>('.quit-confirm-detail-preview');
    expect(preview!.style.background).toBe('#282a36'); // dracula

    // Click row 2 — the bg map lookup swaps to the second entry's
    // resolved bg.
    const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('.quit-confirm-row'));
    rows[1].click();
    expect(preview!.style.background).toBe('#0d1117'); // github-dark

    document.querySelector<HTMLButtonElement>('.quit-confirm-btn-cancel')?.click();
  });
});
