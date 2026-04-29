/**
 * HS-7983 — pure-helper tests for the client-side ANSI strip helper used
 * by the Commands Log streaming live render. Mirrors the server-side
 * `scrollbackSnapshot.test.ts` cases so the two implementations stay in
 * sync; if the regex set drifts between server and client, a streaming
 * preview rendered locally would diverge from a server-side scrollback
 * snapshot rendered for the §37 quit-confirm preview. (HS-8015 removed
 * the sidebar partial-preview consumer alongside the `tailLines` helper
 * it depended on.)
 */
import { describe, expect, it } from 'vitest';

import { stripAnsi } from './stripAnsi.js';

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
