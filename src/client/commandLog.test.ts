// @vitest-environment happy-dom
/**
 * HS-7983 — pure-helper tests for `shouldAutoScrollToBottom` PLUS a
 * happy-dom integration test for the live-render listener wired in
 * `initCommandLog`. The listener is the one piece that stitches together
 * the partial-output event, the per-entry `<pre data-shell-partial-id>`
 * marker, the stripAnsi pipeline, and the sticky-bottom auto-scroll.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyShellPartialEvent, shouldAutoScrollToBottom } from './commandLog.js';
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

function setupEntriesContainer(entryIds: number[]): HTMLElement {
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
