/**
 * HS-7969 — pure-helper tests for the quit-confirm scrollback preview.
 */
import { describe, expect, it } from 'vitest';

import { stripAnsi, tailLines } from './scrollbackSnapshot.js';

describe('stripAnsi (HS-7969)', () => {
  it('removes a CSI cursor-position sequence', () => {
    expect(stripAnsi('\x1b[2J\x1b[Hhello')).toBe('hello');
  });

  it('removes a coloured prompt', () => {
    expect(stripAnsi('\x1b[31mERROR\x1b[0m: oops')).toBe('ERROR: oops');
  });

  it('removes an OSC title sequence terminated by BEL', () => {
    expect(stripAnsi('\x1b]0;my-window\x07ready')).toBe('ready');
  });

  it('removes an OSC sequence terminated by ST', () => {
    expect(stripAnsi('\x1b]7;file:///tmp\x1b\\hello')).toBe('hello');
  });

  it('drops backspaces', () => {
    expect(stripAnsi('hi\x08\x08bye')).toBe('hibye');
  });

  it('collapses bare CR into LF (carriage return without LF)', () => {
    expect(stripAnsi('progress: 50%\rprogress: 100%\n')).toBe('progress: 50%\nprogress: 100%\n');
  });

  it('preserves CRLF as-is (the LF stays; CR was non-trailing)', () => {
    expect(stripAnsi('a\r\nb\r\n')).toBe('a\r\nb\r\n');
  });

  it('handles plain text unchanged', () => {
    expect(stripAnsi('plain output')).toBe('plain output');
  });
});

describe('tailLines (HS-7969)', () => {
  it('returns the last N lines', () => {
    expect(tailLines('a\nb\nc\nd\ne', 3)).toBe('c\nd\ne');
  });

  it('returns the whole text when fewer lines than requested', () => {
    expect(tailLines('only one line', 5)).toBe('only one line');
  });

  it('drops a single trailing newline before slicing', () => {
    expect(tailLines('a\nb\nc\n', 2)).toBe('b\nc');
  });

  it('returns empty string for maxLines=0', () => {
    expect(tailLines('a\nb', 0)).toBe('');
  });

  it('handles empty input', () => {
    expect(tailLines('', 5)).toBe('');
  });
});

// HS-8045 — `buildScrollbackPreview` + `buildScrollbackPreviewWithAnsi`
// describe blocks deleted alongside the helpers themselves. The §37
// quit-confirm preview pane (HS-7969 / HS-8041) now renders the real
// `terminalCheckout` xterm canvas instead of an ANSI-spans-rendered
// snapshot, so neither helper has remaining callers. `stripAnsi` and
// `tailLines` remain exported with their existing test coverage.
