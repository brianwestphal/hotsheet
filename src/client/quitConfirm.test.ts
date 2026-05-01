// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { evaluateQuitDecision, type QuitSummary, showQuitConfirmDialog } from './quitConfirm.js';
import { _getTermForTesting, _inspectStackForTesting, _resetForTesting, checkout, entryCount } from './terminalCheckout.js';

function project(
  name: string,
  confirmMode: 'always' | 'never' | 'with-non-exempt-processes',
  entries: Array<{ label: string; cmd: string; isExempt: boolean; isShell?: boolean }>,
) {
  return {
    secret: `secret-${name}`,
    name,
    confirmMode,
    entries: entries.map(e => ({
      terminalId: e.label,
      label: e.label,
      foregroundCommand: e.cmd,
      isShell: e.isShell ?? false,
      isExempt: e.isExempt,
    })),
  };
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
 * HS-8058 — the quit-confirm preview pane must paint its container bg
 * to match the live xterm's theme background so the sub-cell slop
 * around the canvas (the right + bottom gutter where `cols * cellW` /
 * `rows * cellH` doesn't fully cover the pane content area) reads as
 * part of the terminal rather than as the contrasting gray pane the
 * user reported as "text poking out of terminal bounds".
 */
describe('quit-confirm preview pane theme-bg cascade (HS-8058)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    _resetForTesting();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    _resetForTesting();
    document.querySelectorAll('.quit-confirm-overlay').forEach(el => el.remove());
  });

  it('applies the live term theme background to the preview pane on row select', () => {
    // Pre-create the entry so we can poke its theme BEFORE the dialog's
    // auto-select fires its checkout. Keep the seed handle alive across
    // the dialog open so the entry isn't disposed (releasing the only
    // consumer empties the stack and tears the term down). The dialog's
    // checkout then pushes onto the existing entry's stack and shares
    // the same term — which carries the seed's theme.
    const proj = project('proj-A', 'always', [
      { label: 'a-claude', cmd: 'claude', isExempt: false },
    ]);
    const sink = document.createElement('div');
    document.body.appendChild(sink);
    const seedHandle = checkout({
      projectSecret: 'secret-proj-A',
      terminalId: 'a-claude',
      cols: 80,
      rows: 24,
      mountInto: sink,
    });
    seedHandle.term.options.theme = { background: 'rgb(40, 42, 54)' };

    void showQuitConfirmDialog([proj]);

    // Auto-select fired synchronously; the handle reads the term's
    // current theme bg and applies it inline on the preview pane.
    const preview = document.querySelector<HTMLElement>('.quit-confirm-detail-preview');
    expect(preview).not.toBeNull();
    expect(preview!.style.background).toBe('rgb(40, 42, 54)');

    // Sanity: the live term is the one we expect.
    const term = _getTermForTesting('secret-proj-A', 'a-claude');
    expect(term).not.toBeNull();

    document.querySelector<HTMLButtonElement>('.quit-confirm-btn-cancel')?.click();
    seedHandle.release();
    sink.remove();
  });

  it('leaves the inline background empty when the term has no theme set (CSS fallback wins)', () => {
    void showQuitConfirmDialog([
      project('proj-A', 'always', [
        { label: 'a-claude', cmd: 'claude', isExempt: false },
      ]),
    ]);

    // No prior consumer set a theme — the term defaults are unchanged
    // so the bg-set guard's typeof-string check fails and the inline
    // background stays empty (the SCSS gray fallback paints).
    const preview = document.querySelector<HTMLElement>('.quit-confirm-detail-preview');
    expect(preview).not.toBeNull();
    expect(preview!.style.background).toBe('');

    document.querySelector<HTMLButtonElement>('.quit-confirm-btn-cancel')?.click();
  });

  it('updates the bg when the user switches rows to a terminal with a different theme', () => {
    const proj = project('proj-A', 'always', [
      { label: 'a-claude', cmd: 'claude', isExempt: false },
      { label: 'a-htop', cmd: 'htop', isExempt: true },
    ]);

    // Seed BOTH terminals with distinct theme bgs so the swap path has
    // a visible delta. Keep both seed handles alive across the dialog
    // so the entries aren't disposed when each seed releases its only
    // consumer (the dialog's checkout pushes onto the same stacks).
    const sinks: HTMLDivElement[] = [];
    const seeds: ReturnType<typeof checkout>[] = [];
    for (const [tid, bg] of [['a-claude', 'rgb(40, 42, 54)'], ['a-htop', 'rgb(13, 17, 23)']] as const) {
      const sink = document.createElement('div');
      document.body.appendChild(sink);
      sinks.push(sink);
      const h = checkout({ projectSecret: 'secret-proj-A', terminalId: tid, cols: 80, rows: 24, mountInto: sink });
      h.term.options.theme = { background: bg };
      seeds.push(h);
    }

    void showQuitConfirmDialog([proj]);

    const preview = document.querySelector<HTMLElement>('.quit-confirm-detail-preview');
    expect(preview!.style.background).toBe('rgb(40, 42, 54)'); // first row's theme

    // Click row 2 — checkout swaps to the other terminal-id and
    // re-applies that term's bg.
    const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('.quit-confirm-row'));
    rows[1].click();
    expect(preview!.style.background).toBe('rgb(13, 17, 23)');

    document.querySelector<HTMLButtonElement>('.quit-confirm-btn-cancel')?.click();
    for (const s of seeds) s.release();
    for (const s of sinks) s.remove();
  });
});
