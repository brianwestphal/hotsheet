// HS-9506 (docs/132 §132.9.1) — the shared newline splitter behind both stdio drives.
//
// The cases below are mostly about what the splitter deliberately does NOT do. It was
// extracted from two transports with different line policies (ACP parses + drops blanks,
// codex passes raw lines through), so any filtering that crept in here would silently
// change one of them. These tests pin "verbatim, no policy" as the contract.

import { describe, expect, it } from 'vitest';

import { createLineSplitter } from './lineFraming.js';

describe('createLineSplitter (HS-9506)', () => {
  it('emits complete lines without their terminator', () => {
    const s = createLineSplitter();
    expect(s.push('a\nb\n')).toEqual(['a', 'b']);
  });

  it('buffers a partial trailing line until its newline arrives', () => {
    const s = createLineSplitter();
    expect(s.push('{"id":1')).toEqual([]);
    expect(s.push(',"x":2}')).toEqual([]);
    expect(s.push('\n')).toEqual(['{"id":1,"x":2}']);
  });

  it('splits a chunk carrying several messages at once', () => {
    const s = createLineSplitter();
    // A busy agent's stdout arrives coalesced; dropping all but the first would
    // silently lose protocol messages.
    expect(s.push('one\ntwo\nthree\n')).toEqual(['one', 'two', 'three']);
  });

  it('handles a newline split across chunk boundaries', () => {
    const s = createLineSplitter();
    expect(s.push('first')).toEqual([]);
    expect(s.push('\nsecond\n')).toEqual(['first', 'second']);
  });

  it('KEEPS blank lines — filtering is the caller policy, not the splitter', () => {
    const s = createLineSplitter();
    // codex hands every line to its dispatcher; a splitter that swallowed blanks
    // would be changing that transport's stream to suit ACP's preferences.
    expect(s.push('a\n\nb\n')).toEqual(['a', '', 'b']);
  });

  it('does NOT trim — whitespace is preserved verbatim', () => {
    const s = createLineSplitter();
    expect(s.push('  spaced  \n\ttabbed\n')).toEqual(['  spaced  ', '\ttabbed']);
  });

  it('keeps a carriage return, since it is the caller who knows if \\r\\n is expected', () => {
    const s = createLineSplitter();
    expect(s.push('a\r\n')).toEqual(['a\r']);
  });

  it('returns nothing for an empty chunk and keeps prior buffered content', () => {
    const s = createLineSplitter();
    expect(s.push('partial')).toEqual([]);
    expect(s.push('')).toEqual([]);
    expect(s.push('\n')).toEqual(['partial']);
  });

  it('keeps separate instances independent', () => {
    const a = createLineSplitter();
    const b = createLineSplitter();
    a.push('from-a');
    expect(b.push('from-b\n')).toEqual(['from-b']);
    expect(a.push('\n')).toEqual(['from-a']);
  });
});
