import { describe, expect, it } from 'vitest';

import { looksLikeBinaryContent } from './writePermissionPreview.js';

describe('looksLikeBinaryContent (HS-8296)', () => {
  it('classifies pure ASCII text as text', () => {
    expect(looksLikeBinaryContent('hello world\n')).toBe(false);
  });

  it('classifies multi-line UTF-8 text as text', () => {
    expect(looksLikeBinaryContent('héllo\nwörld\n— em-dash —\n')).toBe(false);
  });

  it('classifies the empty string as text', () => {
    // Empty content is a legitimate Write target (e.g. `touch foo.txt`
    // equivalent). Don't mark it as binary.
    expect(looksLikeBinaryContent('')).toBe(false);
  });

  it('classifies content with one stray bell char as text (under threshold)', () => {
    // \x07 is non-printable but a single occurrence in a 100-char
    // string is 1% — at the threshold (strictly > 1% triggers binary).
    expect(looksLikeBinaryContent('a'.repeat(99) + '\x07')).toBe(false);
  });

  it('classifies content with mostly NUL bytes as binary', () => {
    expect(looksLikeBinaryContent('\0'.repeat(50) + 'x'.repeat(50))).toBe(true);
  });

  it('classifies content with a heavy dose of control chars as binary', () => {
    // 5% non-printable C0 chars — well above the 1% threshold.
    const probe = 'x'.repeat(95) + '\x01\x02\x03\x04\x05';
    expect(looksLikeBinaryContent(probe)).toBe(true);
  });

  it('preserves tab / newline / carriage-return as text (not control)', () => {
    // These three chars are explicitly whitelisted — common in plain text.
    const text = 'col1\tcol2\nline2\r\nline3\n';
    expect(looksLikeBinaryContent(text)).toBe(false);
  });

  it('only probes the first 4 KB of content', () => {
    // First 4 KB clean; binary garbage past that boundary should NOT
    // flip the classification (perf guard: we don't scan a 100 MB
    // upload to decide whether to render its first frame as binary).
    const head = 'a'.repeat(4096);
    const tail = '\0'.repeat(10_000);
    expect(looksLikeBinaryContent(head + tail)).toBe(false);
  });
});
