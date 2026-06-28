/**
 * HS-9129 — unit coverage for the pure permission-popup helpers. `shouldUseLiveCheckout`
 * is exercised broadly via `permissionOverlay.test.ts`; this file pins
 * `extractWriteFields` (every reject branch) + the headline `shouldUseLiveCheckout`
 * triggers so the helper module's branches are fully covered in isolation.
 */
import { describe, expect, it } from 'vitest';

import { extractWriteFields, shouldUseLiveCheckout } from './permissionOverlayHelpers.js';
import type { EditDiffShape } from './permissionPreview.js';

describe('extractWriteFields', () => {
  it('extracts file_path + content from valid Write JSON', () => {
    expect(extractWriteFields('{"file_path":"/a/b.txt","content":"hi"}')).toEqual({ filePath: '/a/b.txt', content: 'hi' });
  });
  it('accepts empty content (create-empty-file)', () => {
    expect(extractWriteFields('{"file_path":"/a/b.txt","content":""}')).toEqual({ filePath: '/a/b.txt', content: '' });
  });
  it('returns null for an empty string', () => { expect(extractWriteFields('')).toBeNull(); });
  it('returns null for malformed JSON', () => { expect(extractWriteFields('{not json')).toBeNull(); });
  it('returns null for non-object JSON (array / primitive / null)', () => {
    expect(extractWriteFields('[1,2]')).toBeNull();
    expect(extractWriteFields('"a string"')).toBeNull();
    expect(extractWriteFields('null')).toBeNull();
  });
  it('returns null when file_path is missing or empty', () => {
    expect(extractWriteFields('{"content":"x"}')).toBeNull();
    expect(extractWriteFields('{"file_path":"","content":"x"}')).toBeNull();
  });
  it('returns null when content is missing or not a string', () => {
    expect(extractWriteFields('{"file_path":"/a"}')).toBeNull();
    expect(extractWriteFields('{"file_path":"/a","content":123}')).toBeNull();
  });
});

describe('shouldUseLiveCheckout', () => {
  const noDiff: EditDiffShape | null = null;
  it('Bash never uses the live checkout, even for long/multiline previews', () => {
    expect(shouldUseLiveCheckout('Bash', noDiff, 'x'.repeat(200))).toBe(false);
    expect(shouldUseLiveCheckout('Bash', noDiff, 'a\nb')).toBe(false);
  });
  it('an Edit/Write diff always triggers', () => {
    expect(shouldUseLiveCheckout('Edit', {} as EditDiffShape, 'short')).toBe(true);
  });
  it('empty preview stays static', () => { expect(shouldUseLiveCheckout('Read', noDiff, '')).toBe(false); });
  it('truncated (ends in ellipsis), multiline, or long single-line previews trigger', () => {
    expect(shouldUseLiveCheckout('Read', noDiff, 'partial…')).toBe(true);
    expect(shouldUseLiveCheckout('WebFetch', noDiff, 'line1\nline2')).toBe(true);
    expect(shouldUseLiveCheckout('Read', noDiff, 'y'.repeat(81))).toBe(true);
  });
  it('a short single-line non-Bash preview stays static', () => {
    expect(shouldUseLiveCheckout('Read', noDiff, 'config.ts')).toBe(false);
  });
});
