/**
 * HS-7983 — pure-helper tests for the client-side ANSI strip + tail
 * helpers used by the streaming-shell-output sidebar preview and the
 * Commands Log live render. Mirrors the server-side
 * `scrollbackSnapshot.test.ts` cases so the two implementations stay in
 * sync; if the regex set drifts between server and client a Phase 3
 * preview rendered locally would diverge from a server-side scrollback
 * snapshot rendered for the §37 quit-confirm preview.
 */
import { describe, expect, it } from 'vitest';

import { stripAnsi, tailLines } from './stripAnsi.js';

describe('stripAnsi (HS-7983)', () => {
  it('removes CSI sequences (clear, home)', () => {
    expect(stripAnsi('\x1b[2J\x1b[Hhello')).toBe('hello');
  });

  it('removes SGR colour codes', () => {
    expect(stripAnsi('\x1b[31mERROR\x1b[0m: oops')).toBe('ERROR: oops');
  });

  it('removes OSC sequences terminated with BEL', () => {
    expect(stripAnsi('\x1b]0;my-window\x07ready')).toBe('ready');
  });

  it('removes OSC sequences terminated with ST', () => {
    expect(stripAnsi('\x1b]7;file:///tmp\x1b\\hello')).toBe('hello');
  });

  it('drops backspace bytes (BS)', () => {
    expect(stripAnsi('hi\x08\x08bye')).toBe('hibye');
  });

  it('collapses lone CR to LF (progress-bar redraws)', () => {
    expect(stripAnsi('progress: 50%\rprogress: 100%\n')).toBe('progress: 50%\nprogress: 100%\n');
  });

  it('preserves CRLF line endings as-is', () => {
    expect(stripAnsi('a\r\nb\r\n')).toBe('a\r\nb\r\n');
  });

  it('passes plain text through unchanged', () => {
    expect(stripAnsi('plain output')).toBe('plain output');
  });
});

describe('tailLines (HS-7983)', () => {
  it('returns empty when maxLines <= 0', () => {
    expect(tailLines('a\nb\nc', 0)).toBe('');
    expect(tailLines('a\nb\nc', -1)).toBe('');
  });

  it('returns the full text when there are fewer lines than the cap', () => {
    expect(tailLines('a\nb\nc', 5)).toBe('a\nb\nc');
  });

  it('returns the trailing N lines when the cap is exceeded', () => {
    expect(tailLines('a\nb\nc\nd\ne', 2)).toBe('d\ne');
  });

  it('drops a single trailing empty line so we don\'t waste a slot', () => {
    expect(tailLines('a\nb\nc\n', 2)).toBe('b\nc');
  });

  it('handles an empty input', () => {
    expect(tailLines('', 5)).toBe('');
  });
});
