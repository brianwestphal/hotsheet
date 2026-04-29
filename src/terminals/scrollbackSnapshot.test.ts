/**
 * HS-7969 — pure-helper tests for the quit-confirm scrollback preview.
 */
import { describe, expect, it } from 'vitest';

import { buildScrollbackPreview, buildScrollbackPreviewWithAnsi, stripAnsi, tailLines } from './scrollbackSnapshot.js';

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

describe('buildScrollbackPreview (HS-7969)', () => {
  it('returns empty string for an empty buffer', () => {
    expect(buildScrollbackPreview(Buffer.alloc(0), 30)).toBe('');
  });

  it('strips ANSI and tails to maxLines', () => {
    const raw = '\x1b[31mline1\x1b[0m\nline2\nline3\nline4';
    expect(buildScrollbackPreview(Buffer.from(raw), 2)).toBe('line3\nline4');
  });

  it('preserves multi-byte UTF-8 chars (e.g. spinner glyphs)', () => {
    const raw = '✻ Compiling…\nDone';
    expect(buildScrollbackPreview(Buffer.from(raw, 'utf-8'), 10)).toBe('✻ Compiling…\nDone');
  });
});

describe('buildScrollbackPreviewWithAnsi (HS-7969 follow-up #2)', () => {
  it('returns empty string for an empty buffer', () => {
    expect(buildScrollbackPreviewWithAnsi(Buffer.alloc(0), 30)).toBe('');
  });

  it('preserves SGR sequences and tails to maxLines', () => {
    const raw = '\x1b[31mline1\x1b[0m\nline2\nline3\nline4';
    expect(buildScrollbackPreviewWithAnsi(Buffer.from(raw), 2)).toBe('line3\nline4');
  });

  it('keeps coloured prompt formatting in the output', () => {
    const raw = '\x1b[1;32mok\x1b[0m: done\nplain';
    expect(buildScrollbackPreviewWithAnsi(Buffer.from(raw), 5)).toBe('\x1b[1;32mok\x1b[0m: done\nplain');
  });

  it('still drops backspace and bare-CR', () => {
    // CR alone collapses to LF (matches the stripped-text path), backspace
    // is dropped — both are noise for a static preview.
    const raw = 'a\bb\rc';
    expect(buildScrollbackPreviewWithAnsi(Buffer.from(raw), 5)).toBe('ab\nc');
  });

  it('preserves multi-byte UTF-8 chars', () => {
    const raw = '\x1b[36m✻\x1b[0m Compiling…';
    expect(buildScrollbackPreviewWithAnsi(Buffer.from(raw, 'utf-8'), 5)).toBe('\x1b[36m✻\x1b[0m Compiling…');
  });
});
