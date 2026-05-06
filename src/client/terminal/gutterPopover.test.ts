/**
 * HS-8194 — Tests for the OSC 133 gutter-glyph hover popover extracted from
 * `terminal.tsx`. The popover render is exercised through `attachGutterHoverPopover`,
 * which wires mouseenter / mouseleave on a fake glyph element. We mock the
 * `channelUI.js` and `terminalOsc133.js` imports so the tests don't need a
 * real channel server or xterm runtime.
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../channelUI.js', () => ({
  isChannelAlive: vi.fn(() => true),
  triggerChannelAndMarkBusy: vi.fn(),
}));
vi.mock('../terminalOsc133.js', () => ({
  buildAskClaudePrompt: vi.fn((args: unknown) => `ASK:${JSON.stringify(args)}`),
}));

// eslint-disable-next-line import/first
import * as channelUI from '../channelUI.js';
// eslint-disable-next-line import/first
import { attachGutterHoverPopover, type CommandRecord } from './gutterPopover.js';

interface FakeMarker {
  line: number;
  isDisposed: boolean;
}

interface FakeBufferLine {
  translateToString(trim?: boolean): string;
}

interface FakeBuffer {
  cursorY: number;
  baseY: number;
  getLine(y: number): FakeBufferLine | undefined;
}

interface FakeXTerm {
  buffer: { active: FakeBuffer };
  paste: ReturnType<typeof vi.fn>;
}

function makeRecord(opts: { hasD?: boolean } = {}): CommandRecord {
  return {
    id: 1,
    promptStart: { line: 0, isDisposed: false } as unknown as FakeMarker as never,
    commandStart: { line: 1, isDisposed: false } as unknown as FakeMarker as never,
    outputStart: { line: 2, isDisposed: false } as unknown as FakeMarker as never,
    commandEnd: opts.hasD === false ? null : { line: 4, isDisposed: false } as unknown as FakeMarker as never,
    exitCode: 0,
    decoration: null,
  };
}

function makeTerm(linesAt: Partial<Record<number, string>> = {}): FakeXTerm {
  return {
    buffer: {
      active: {
        cursorY: 0,
        baseY: 0,
        getLine: (y: number) => {
          const text = linesAt[y];
          if (text === undefined) return undefined;
          return { translateToString: () => text };
        },
      },
    },
    paste: vi.fn(),
  };
}

beforeEach(() => {
  vi.mocked(channelUI.isChannelAlive).mockReturnValue(true);
  vi.mocked(channelUI.triggerChannelAndMarkBusy).mockReset();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('attachGutterHoverPopover (HS-8194)', () => {
  it('mouseenter on the glyph mounts the popover with all four actions when channel is alive', () => {
    const glyph = document.createElement('div');
    document.body.appendChild(glyph);
    const term = makeTerm();
    attachGutterHoverPopover(glyph, term as never, makeRecord(), { getCwd: () => '/tmp' });
    glyph.dispatchEvent(new MouseEvent('mouseenter'));
    const popover = document.querySelector('.terminal-osc133-popover');
    expect(popover).not.toBeNull();
    expect(popover!.querySelectorAll('.terminal-osc133-popover-btn')).toHaveLength(4);
    expect(popover!.querySelector('[data-action="ask-claude"]')).not.toBeNull();
  });

  it('omits Ask Claude when channel is offline', () => {
    vi.mocked(channelUI.isChannelAlive).mockReturnValue(false);
    const glyph = document.createElement('div');
    document.body.appendChild(glyph);
    attachGutterHoverPopover(glyph, makeTerm() as never, makeRecord(), { getCwd: () => null });
    glyph.dispatchEvent(new MouseEvent('mouseenter'));
    const popover = document.querySelector('.terminal-osc133-popover')!;
    expect(popover.querySelectorAll('.terminal-osc133-popover-btn')).toHaveLength(3);
    expect(popover.querySelector('[data-action="ask-claude"]')).toBeNull();
  });

  it('clicking Ask Claude reads command + output and dispatches via triggerChannelAndMarkBusy', () => {
    const glyph = document.createElement('div');
    document.body.appendChild(glyph);
    const term = makeTerm({ 1: 'echo hi', 2: 'hi', 3: '' });
    attachGutterHoverPopover(glyph, term as never, makeRecord(), { getCwd: () => '/var/x' });
    glyph.dispatchEvent(new MouseEvent('mouseenter'));
    const askBtn = document.querySelector<HTMLButtonElement>('[data-action="ask-claude"]')!;
    askBtn.click();
    expect(vi.mocked(channelUI.triggerChannelAndMarkBusy)).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(channelUI.triggerChannelAndMarkBusy).mock.calls[0][0];
    expect(arg).toContain('"command":"echo hi"');
    expect(arg).toContain('"cwd":"/var/x"');
  });

  it('clicking Rerun pastes the command + carriage return into the term', () => {
    const glyph = document.createElement('div');
    document.body.appendChild(glyph);
    const term = makeTerm({ 1: 'ls -la' });
    attachGutterHoverPopover(glyph, term as never, makeRecord(), { getCwd: () => null });
    glyph.dispatchEvent(new MouseEvent('mouseenter'));
    document.querySelector<HTMLButtonElement>('[data-action="rerun"]')!.click();
    expect(term.paste).toHaveBeenCalledWith('ls -la\r');
  });

  it('clicking any action closes the popover', () => {
    const glyph = document.createElement('div');
    document.body.appendChild(glyph);
    attachGutterHoverPopover(glyph, makeTerm({ 1: 'x' }) as never, makeRecord(), { getCwd: () => null });
    glyph.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.querySelector('.terminal-osc133-popover')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('[data-action="rerun"]')!.click();
    expect(document.querySelector('.terminal-osc133-popover')).toBeNull();
  });

  it('mouseleave on the glyph schedules a delayed close that mouseenter on the popover cancels', () => {
    vi.useFakeTimers();
    const glyph = document.createElement('div');
    document.body.appendChild(glyph);
    attachGutterHoverPopover(glyph, makeTerm() as never, makeRecord(), { getCwd: () => null });
    glyph.dispatchEvent(new MouseEvent('mouseenter'));
    const popover = document.querySelector('.terminal-osc133-popover')!;
    glyph.dispatchEvent(new MouseEvent('mouseleave'));
    // Cursor enters popover before the delay fires — cancels the close.
    popover.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);
    expect(document.querySelector('.terminal-osc133-popover')).not.toBeNull();
  });

  it('a second mouseenter on a different glyph replaces the first popover', () => {
    const glyphA = document.createElement('div');
    const glyphB = document.createElement('div');
    document.body.appendChild(glyphA);
    document.body.appendChild(glyphB);
    attachGutterHoverPopover(glyphA, makeTerm() as never, makeRecord(), { getCwd: () => null });
    attachGutterHoverPopover(glyphB, makeTerm() as never, makeRecord(), { getCwd: () => null });
    glyphA.dispatchEvent(new MouseEvent('mouseenter'));
    glyphB.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.querySelectorAll('.terminal-osc133-popover')).toHaveLength(1);
  });
});
