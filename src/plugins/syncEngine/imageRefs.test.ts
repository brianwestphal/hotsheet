import { describe, expect, it } from 'vitest';

import { extractImageRefs } from './imageRefs.js';

describe('extractImageRefs (HS-8952)', () => {
  it('extracts the src of a raw <img> tag (the GitHub paste case)', () => {
    const body = '<img width="864" height="134" alt="Image" src="https://github.com/user-attachments/assets/8b24bff2-6860-4927-810a-20ee165ec1d4" />';
    expect(extractImageRefs(body)).toEqual([
      'https://github.com/user-attachments/assets/8b24bff2-6860-4927-810a-20ee165ec1d4',
    ]);
  });

  it('extracts markdown ![alt](url) images, including a trailing title', () => {
    const body = 'before ![a shot](https://example.com/a.png "title") after ![](https://example.com/b.jpg)';
    expect(extractImageRefs(body)).toEqual([
      'https://example.com/a.png',
      'https://example.com/b.jpg',
    ]);
  });

  it('handles both forms in one body and dedups repeated URLs', () => {
    const body = [
      '<img src="https://x.test/1.png">',
      '![](https://x.test/2.png)',
      '<img src="https://x.test/1.png" alt="dup">',
    ].join('\n');
    expect(extractImageRefs(body)).toEqual(['https://x.test/1.png', 'https://x.test/2.png']);
  });

  it('skips data: URIs and relative paths (not downloadable)', () => {
    const body = '<img src="data:image/png;base64,AAAA"> ![](./local.png) ![](/abs/path.png)';
    expect(extractImageRefs(body)).toEqual([]);
  });

  it('returns [] for empty / null bodies', () => {
    expect(extractImageRefs('')).toEqual([]);
    expect(extractImageRefs(null)).toEqual([]);
    expect(extractImageRefs(undefined)).toEqual([]);
    expect(extractImageRefs('no images here')).toEqual([]);
  });

  it('handles single-quoted src attributes', () => {
    expect(extractImageRefs("<img src='https://x.test/q.gif'>")).toEqual(['https://x.test/q.gif']);
  });
});
