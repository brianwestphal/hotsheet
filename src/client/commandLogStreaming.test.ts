// @vitest-environment happy-dom
/** HS-9131 — streaming-shell-output consumer (`commandLogStreaming.ts`): the
 *  pure render/scroll helpers + the gated `applyShellPartialEvent`. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyShellPartialEvent,
  RUNNING_SHELL_PREVIEW_LINES,
  shouldAutoScrollToBottom,
  writePartialIntoPre,
} from './commandLogStreaming.js';

const h = vi.hoisted(() => ({
  fakeState: { settings: { shell_streaming_enabled: true } },
  setRunningOutput: vi.fn(),
  maybeFireToast: vi.fn(),
}));
vi.mock('./state.js', () => ({ state: h.fakeState }));
vi.mock('./commandLogStore.js', () => ({ commandLogStore: { actions: { setRunningOutput: h.setRunningOutput } } }));
vi.mock('./commandSidebar.js', () => ({ maybeFireShellStreamFirstUseToast: h.maybeFireToast }));

beforeEach(() => {
  h.fakeState.settings.shell_streaming_enabled = true;
  h.setRunningOutput.mockReset();
  h.maybeFireToast.mockReset();
});
afterEach(() => { document.body.innerHTML = ''; });

describe('writePartialIntoPre', () => {
  it('strips ANSI and writes the full text in non-preview mode', () => {
    const pre = document.createElement('pre');
    writePartialIntoPre(pre, '[31mred[0m line');
    expect(pre.textContent).toBe('red line');
  });
  it('tails to the last N lines in preview mode', () => {
    const pre = document.createElement('pre');
    pre.dataset.shellPartialMode = 'preview';
    writePartialIntoPre(pre, 'l1\nl2\nl3\nl4\nl5');
    expect(pre.textContent).toBe('l3\nl4\nl5');
    expect(RUNNING_SHELL_PREVIEW_LINES).toBe(3);
  });
});

describe('shouldAutoScrollToBottom', () => {
  it('true when pinned within the threshold of the bottom', () => {
    expect(shouldAutoScrollToBottom(992, 100, 1100)).toBe(true); // 1092 >= 1100-8
  });
  it('false when scrolled up beyond the threshold', () => {
    expect(shouldAutoScrollToBottom(900, 100, 1100)).toBe(false); // 1000 < 1092
  });
  it('honors a custom threshold', () => {
    expect(shouldAutoScrollToBottom(900, 100, 1100, 200)).toBe(true); // 1000 >= 900
  });
});

describe('applyShellPartialEvent', () => {
  it('no-ops when streaming is disabled', () => {
    h.fakeState.settings.shell_streaming_enabled = false;
    applyShellPartialEvent({ id: 5, partial: 'x' });
    expect(h.setRunningOutput).not.toHaveBeenCalled();
    expect(h.maybeFireToast).not.toHaveBeenCalled();
  });
  it('fires the first-use toast and writes through the store when enabled', () => {
    applyShellPartialEvent({ id: 7, partial: 'chunk' });
    expect(h.maybeFireToast).toHaveBeenCalledTimes(1);
    expect(h.setRunningOutput).toHaveBeenCalledWith(7, 'chunk');
  });
});
