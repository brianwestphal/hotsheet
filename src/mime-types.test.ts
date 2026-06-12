import { describe, expect, it } from 'vitest';

import { getMimeType, MIME_TYPES } from './mime-types.js';

describe('getMimeType', () => {
  it('looks up a known extension with a leading dot', () => {
    expect(getMimeType('.png')).toBe('image/png');
  });

  it('accepts an extension without a leading dot', () => {
    expect(getMimeType('png')).toBe('image/png');
  });

  it('is case-insensitive', () => {
    expect(getMimeType('.PNG')).toBe('image/png');
    expect(getMimeType('JPG')).toBe('image/jpeg');
  });

  it('falls back to application/octet-stream for an unknown extension', () => {
    expect(getMimeType('.xyz')).toBe('application/octet-stream');
    expect(getMimeType('')).toBe('application/octet-stream');
  });

  it('maps every entry in the table consistently', () => {
    for (const [ext, type] of Object.entries(MIME_TYPES)) {
      expect(getMimeType(ext)).toBe(type);
      expect(getMimeType(ext.slice(1))).toBe(type); // without the dot
    }
  });
});
