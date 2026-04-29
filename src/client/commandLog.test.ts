// @vitest-environment happy-dom
/**
 * HS-7983 — pure-helper tests for `shouldAutoScrollToBottom` PLUS a
 * happy-dom integration test for the live-render listener wired in
 * `initCommandLog`. The listener is the one piece that stitches together
 * the partial-output event, the per-entry `<pre data-shell-partial-id>`
 * marker, the stripAnsi pipeline, and the sticky-bottom auto-scroll.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyShellPartialEvent, hydrateRenderedShellPartials, shouldAutoScrollToBottom, writePartialIntoPre } from './commandLog.js';
import { state } from './state.js';

describe('shouldAutoScrollToBottom (HS-7983)', () => {
  it('returns true when scrolled exactly to the bottom', () => {
    // scrollTop + clientHeight === scrollHeight
    expect(shouldAutoScrollToBottom(500, 200, 700)).toBe(true);
  });

  it('returns true within the default 8 px threshold', () => {
    // scrollTop + clientHeight = 698, scrollHeight - threshold = 692.
    // 698 >= 692 → pinned.
    expect(shouldAutoScrollToBottom(498, 200, 700)).toBe(true);
  });

  it('returns false when the user has scrolled up past the threshold', () => {
    // scrollTop + clientHeight = 600, scrollHeight - threshold = 692.
    expect(shouldAutoScrollToBottom(400, 200, 700)).toBe(false);
  });

  it('honours a custom threshold (zero — exact-bottom only)', () => {
    expect(shouldAutoScrollToBottom(499, 200, 700, 0)).toBe(false);
    expect(shouldAutoScrollToBottom(500, 200, 700, 0)).toBe(true);
  });

  it('returns true when content fits without scrolling', () => {
    // clientHeight >= scrollHeight (no scrollbar). scrollTop is 0.
    expect(shouldAutoScrollToBottom(0, 500, 200)).toBe(true);
  });

  it('returns false at the very top of a long scroll', () => {
    expect(shouldAutoScrollToBottom(0, 200, 5000)).toBe(false);
  });

  it('handles fractional scrollTop (sub-pixel rounding)', () => {
    // Browsers can return non-integer scrollTop on hi-dpi displays. The
    // 8 px default threshold absorbs this.
    expect(shouldAutoScrollToBottom(499.7, 200, 700)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HS-7983 — applyShellPartialEvent (happy-dom integration)
// ---------------------------------------------------------------------------

/**
 * Mount the running-shell entry layout used in production. Each entry
 * gets twin pres tagged with `data-shell-partial-id` (preview + full)
 * matching the JSX in `renderLogEntry`'s running-shell branch.
 *
 * The first pre (preview) has no `data-shell-partial-mode` attribute by
 * default — kept that way so the legacy `applyShellPartialEvent` tests
 * (written before the twin-pre layout) still observe the same "writer
 * paints the full buffer" behaviour. New tests opt into the twin-pre
 * layout by passing `withFullPre: true`.
 */
function setupEntriesContainer(entryIds: number[], opts: { withFullPre?: boolean } = {}): HTMLElement {
  const container = document.createElement('div');
  container.id = 'command-log-entries';
  for (const id of entryIds) {
    const entry = document.createElement('div');
    entry.className = 'command-log-entry';
    entry.dataset.id = String(id);
    const pre = document.createElement('pre');
    pre.className = 'command-log-detail command-log-shell-partial';
    pre.dataset.shellPartialId = String(id);
    entry.appendChild(pre);
    if (opts.withFullPre === true) {
      pre.dataset.shellPartialMode = 'preview';
      pre.classList.add('command-log-shell-partial-preview');
      const full = document.createElement('pre');
      full.className = 'command-log-detail-full command-log-shell-partial command-log-shell-partial-full';
      full.dataset.shellPartialId = String(id);
      full.dataset.shellPartialMode = 'full';
      full.style.display = 'none';
      entry.appendChild(full);
    }
    container.appendChild(entry);
  }
  document.body.appendChild(container);
  return container;
}

describe('applyShellPartialEvent (HS-7983)', () => {
  it('writes the stripped partial into the matching <pre data-shell-partial-id>', () => {
    const container = setupEntriesContainer([42]);
    try {
      applyShellPartialEvent({ id: 42, partial: '\x1b[31mERROR\x1b[0m: oops' });
      const pre = container.querySelector<HTMLElement>('pre[data-shell-partial-id="42"]');
      expect(pre?.textContent).toBe('ERROR: oops');
    } finally {
      container.remove();
    }
  });

  it('overwrites existing partial text on subsequent chunks (no double-paint)', () => {
    const container = setupEntriesContainer([42]);
    try {
      applyShellPartialEvent({ id: 42, partial: 'Stage 1\n' });
      applyShellPartialEvent({ id: 42, partial: 'Stage 1\nStage 2\n' });
      applyShellPartialEvent({ id: 42, partial: 'Stage 1\nStage 2\nStage 3\n' });
      const pre = container.querySelector<HTMLElement>('pre[data-shell-partial-id="42"]');
      expect(pre?.textContent).toBe('Stage 1\nStage 2\nStage 3\n');
    } finally {
      container.remove();
    }
  });

  it('no-ops when the entries container is missing', () => {
    // No `#command-log-entries` mounted — must not throw.
    expect(() => applyShellPartialEvent({ id: 99, partial: 'whatever' })).not.toThrow();
  });

  it('no-ops when no entry matches the event id', () => {
    const container = setupEntriesContainer([42]);
    try {
      applyShellPartialEvent({ id: 999, partial: 'orphan' });
      const matchingPre = container.querySelector<HTMLElement>('pre[data-shell-partial-id="42"]');
      // The id-42 entry's text is unchanged — nothing leaked.
      expect(matchingPre?.textContent).toBe('');
    } finally {
      container.remove();
    }
  });

  it('only updates the entry whose id matches when multiple entries are mounted', () => {
    const container = setupEntriesContainer([42, 43]);
    try {
      applyShellPartialEvent({ id: 43, partial: 'second runs' });
      const e42 = container.querySelector<HTMLElement>('pre[data-shell-partial-id="42"]');
      const e43 = container.querySelector<HTMLElement>('pre[data-shell-partial-id="43"]');
      expect(e42?.textContent).toBe('');
      expect(e43?.textContent).toBe('second runs');
    } finally {
      container.remove();
    }
  });
});

// ---------------------------------------------------------------------------
// HS-7984 — Phase 4 setting gate
// ---------------------------------------------------------------------------

describe('applyShellPartialEvent — shell_streaming_enabled gate (HS-7984)', () => {
  const original = state.settings.shell_streaming_enabled;

  beforeEach(() => {
    state.settings.shell_streaming_enabled = true;
  });

  afterEach(() => {
    state.settings.shell_streaming_enabled = original;
  });

  it('applies the partial when streaming is enabled (sanity)', () => {
    const container = setupEntriesContainer([42]);
    try {
      applyShellPartialEvent({ id: 42, partial: 'live output' });
      expect(container.querySelector<HTMLElement>('pre[data-shell-partial-id="42"]')?.textContent).toBe('live output');
    } finally {
      container.remove();
    }
  });

  it('no-ops when streaming is disabled — the live `<pre>` stays empty', () => {
    state.settings.shell_streaming_enabled = false;
    const container = setupEntriesContainer([42]);
    try {
      applyShellPartialEvent({ id: 42, partial: 'this should not render' });
      expect(container.querySelector<HTMLElement>('pre[data-shell-partial-id="42"]')?.textContent).toBe('');
    } finally {
      container.remove();
    }
  });
});

// ---------------------------------------------------------------------------
// HS-8015 — flicker-free re-render via cached partial repaint
// ---------------------------------------------------------------------------

describe('hydrateRenderedShellPartials (HS-8015)', () => {
  beforeEach(() => {
    state.settings.shell_streaming_enabled = true;
  });

  it('repaints the <pre> from the module cache (event populated, then re-render wiped textContent)', () => {
    // Step 1: an event lands → cache + DOM populated.
    const container1 = setupEntriesContainer([42]);
    try {
      applyShellPartialEvent({ id: 42, partial: 'first chunk' });
      expect(container1.querySelector<HTMLElement>('pre[data-shell-partial-id="42"]')?.textContent).toBe('first chunk');
    } finally {
      container1.remove();
    }

    // Step 2: the periodic poll re-renders the entry (textContent wiped).
    // Pre-fix this is when the user saw the flicker. Post-fix the cache
    // outlives the re-render and `hydrateRenderedShellPartials` repaints.
    const container2 = setupEntriesContainer([42]);
    try {
      const pre = container2.querySelector<HTMLElement>('pre[data-shell-partial-id="42"]')!;
      expect(pre.textContent).toBe(''); // simulating the post-render wiped state

      hydrateRenderedShellPartials();
      expect(pre.textContent).toBe('first chunk');
    } finally {
      container2.remove();
    }
  });

  it('strips ANSI before painting from the cache (matches applyShellPartialEvent behaviour)', () => {
    const c1 = setupEntriesContainer([42]);
    try {
      applyShellPartialEvent({ id: 42, partial: '\x1b[31mFAIL\x1b[0m\n' });
    } finally {
      c1.remove();
    }
    const c2 = setupEntriesContainer([42]);
    try {
      hydrateRenderedShellPartials();
      const pre = c2.querySelector<HTMLElement>('pre[data-shell-partial-id="42"]');
      expect(pre?.textContent).toBe('FAIL\n');
    } finally {
      c2.remove();
    }
  });

  it('skips the paint when the cache has no entry for an id (defensive)', () => {
    // Use an id no other test has touched so the module-level cache stays
    // miss for this id.
    const c = setupEntriesContainer([8015]);
    try {
      hydrateRenderedShellPartials();
      expect(c.querySelector<HTMLElement>('pre[data-shell-partial-id="8015"]')?.textContent).toBe('');
    } finally {
      c.remove();
    }
  });

  it('only updates the matching id when multiple partial pres are mounted', () => {
    const c1 = setupEntriesContainer([42, 43]);
    try {
      applyShellPartialEvent({ id: 42, partial: 'foo' });
      applyShellPartialEvent({ id: 43, partial: 'bar' });
    } finally {
      c1.remove();
    }
    const c2 = setupEntriesContainer([42, 43]);
    try {
      hydrateRenderedShellPartials();
      expect(c2.querySelector<HTMLElement>('pre[data-shell-partial-id="42"]')?.textContent).toBe('foo');
      expect(c2.querySelector<HTMLElement>('pre[data-shell-partial-id="43"]')?.textContent).toBe('bar');
    } finally {
      c2.remove();
    }
  });

  it('no-ops when the entries container is missing', () => {
    expect(() => hydrateRenderedShellPartials()).not.toThrow();
  });

  it('no-ops when streaming is disabled (matches applyShellPartialEvent gate)', () => {
    state.settings.shell_streaming_enabled = false;
    const c = setupEntriesContainer([42]);
    try {
      // Pre populates an empty pre via setupEntriesContainer; even if the
      // cache had data from a prior test, the gate must keep the pre empty.
      hydrateRenderedShellPartials();
      expect(c.querySelector<HTMLElement>('pre[data-shell-partial-id="42"]')?.textContent).toBe('');
    } finally {
      c.remove();
      state.settings.shell_streaming_enabled = true;
    }
  });
});

// ---------------------------------------------------------------------------
// HS-8015 follow-up #2 — twin-pre running-shell layout
// ---------------------------------------------------------------------------
//
// Running-shell rows now mount BOTH a 3-line preview pre + a hidden full
// pre. The live writer fills both: preview gets the trailing 3 lines so
// the user sees the most recent output in the line-clamped row; full
// gets the entire buffer so clicking-to-expand reveals everything. The
// row is expandable while running because the click handler now treats
// `isRunningShell` as expandable even when the command line is short.

describe('writePartialIntoPre (HS-8015 follow-up #2)', () => {
  it('writes the trailing 3 lines into a preview pre (data-shell-partial-mode="preview")', () => {
    const pre = document.createElement('pre');
    pre.dataset.shellPartialMode = 'preview';
    writePartialIntoPre(pre, 'a\nb\nc\nd\ne\n');
    expect(pre.textContent).toBe('c\nd\ne');
  });

  it('writes the full stripped buffer into a full pre (data-shell-partial-mode="full")', () => {
    const pre = document.createElement('pre');
    pre.dataset.shellPartialMode = 'full';
    writePartialIntoPre(pre, '\x1b[31mline1\x1b[0m\nline2\nline3\nline4\nline5\n');
    expect(pre.textContent).toBe('line1\nline2\nline3\nline4\nline5\n');
  });

  it('falls through to full-buffer when no mode attribute is set (back-compat)', () => {
    // Keeps the legacy `setupEntriesContainer` (no mode attr) tests above
    // observing the same "full buffer" behaviour they did pre-fix.
    const pre = document.createElement('pre');
    writePartialIntoPre(pre, 'a\nb\nc\nd\n');
    expect(pre.textContent).toBe('a\nb\nc\nd\n');
  });

  it('strips ANSI from the buffer in both modes', () => {
    const preview = document.createElement('pre');
    preview.dataset.shellPartialMode = 'preview';
    writePartialIntoPre(preview, '\x1b[31mfoo\x1b[0m\n\x1b[32mbar\x1b[0m\n');
    expect(preview.textContent).toBe('foo\nbar');

    const full = document.createElement('pre');
    full.dataset.shellPartialMode = 'full';
    writePartialIntoPre(full, '\x1b[31mfoo\x1b[0m\n\x1b[32mbar\x1b[0m\n');
    expect(full.textContent).toBe('foo\nbar\n');
  });
});

describe('applyShellPartialEvent — twin-pre wiring (HS-8015 follow-up #2)', () => {
  beforeEach(() => {
    state.settings.shell_streaming_enabled = true;
  });

  it('updates BOTH preview and full pres for a single event', () => {
    const container = setupEntriesContainer([42], { withFullPre: true });
    try {
      const partial = 'a\nb\nc\nd\ne\nf\n';
      applyShellPartialEvent({ id: 42, partial });
      const preview = container.querySelector<HTMLElement>('pre[data-shell-partial-mode="preview"]');
      const full = container.querySelector<HTMLElement>('pre[data-shell-partial-mode="full"]');
      // Preview: trailing 3 lines (no trailing empty line since the buffer ends in \n).
      expect(preview?.textContent).toBe('d\ne\nf');
      // Full: entire stripped buffer including the trailing \n.
      expect(full?.textContent).toBe(partial);
    } finally {
      container.remove();
    }
  });

  it('twin pres stay in sync across multiple chunks', () => {
    const container = setupEntriesContainer([42], { withFullPre: true });
    try {
      applyShellPartialEvent({ id: 42, partial: 'one\n' });
      applyShellPartialEvent({ id: 42, partial: 'one\ntwo\n' });
      applyShellPartialEvent({ id: 42, partial: 'one\ntwo\nthree\n' });
      applyShellPartialEvent({ id: 42, partial: 'one\ntwo\nthree\nfour\n' });
      const preview = container.querySelector<HTMLElement>('pre[data-shell-partial-mode="preview"]');
      const full = container.querySelector<HTMLElement>('pre[data-shell-partial-mode="full"]');
      expect(preview?.textContent).toBe('two\nthree\nfour');
      expect(full?.textContent).toBe('one\ntwo\nthree\nfour\n');
    } finally {
      container.remove();
    }
  });
});

describe('hydrateRenderedShellPartials — twin-pre wiring (HS-8015 follow-up #2)', () => {
  beforeEach(() => {
    state.settings.shell_streaming_enabled = true;
  });

  it('repaints both preview and full pres after a wholesale re-render', () => {
    const container1 = setupEntriesContainer([42], { withFullPre: true });
    try {
      applyShellPartialEvent({ id: 42, partial: 'a\nb\nc\nd\ne\n' });
    } finally {
      container1.remove();
    }
    // Simulate the 5 s loadEntries re-render — fresh DOM with empty pres.
    const container2 = setupEntriesContainer([42], { withFullPre: true });
    try {
      hydrateRenderedShellPartials();
      const preview = container2.querySelector<HTMLElement>('pre[data-shell-partial-mode="preview"]');
      const full = container2.querySelector<HTMLElement>('pre[data-shell-partial-mode="full"]');
      expect(preview?.textContent).toBe('c\nd\ne');
      expect(full?.textContent).toBe('a\nb\nc\nd\ne\n');
    } finally {
      container2.remove();
    }
  });
});
