// @vitest-environment happy-dom
/**
 * §78 Announcer (HS-8749) — emphasis range math + DOM rendering for the
 * tier-1 "text + emphasis" PIP visuals.
 */
import { describe, expect, it } from 'vitest';

import { emphasisRanges, renderScript } from './announcerEmphasis.js';

describe('emphasisRanges', () => {
  it('returns no ranges when there is no emphasis', () => {
    expect(emphasisRanges('fixed the export bug', [])).toEqual([]);
  });

  it('matches a single verbatim phrase', () => {
    expect(emphasisRanges('fixed the export bug', ['export bug'])).toEqual([[10, 20]]);
  });

  it('matches every occurrence of a phrase', () => {
    // "test" appears twice.
    expect(emphasisRanges('test the test', ['test'])).toEqual([[0, 4], [9, 13]]);
  });

  it('merges overlapping / adjacent ranges from multiple phrases', () => {
    // "added tests" overlaps "tests" → one merged range, not two.
    const ranges = emphasisRanges('added tests today', ['added tests', 'tests']);
    expect(ranges).toEqual([[0, 11]]);
  });

  it('ignores phrases that are empty or not present', () => {
    expect(emphasisRanges('hello world', ['', 'absent'])).toEqual([]);
  });

  it('is case-sensitive (phrases are verbatim substrings)', () => {
    expect(emphasisRanges('Export bug', ['export'])).toEqual([]);
  });
});

describe('renderScript', () => {
  it('falls back to plain text content when there is no emphasis', () => {
    const el = document.createElement('p');
    renderScript(el, 'plain script', []);
    expect(el.textContent).toBe('plain script');
    expect(el.querySelector('.announcer-em')).toBeNull();
  });

  it('wraps the emphasized phrase in <strong class="announcer-em"> and preserves the full text', () => {
    const el = document.createElement('p');
    renderScript(el, 'fixed the export bug', ['export bug']);
    const strong = el.querySelector('strong.announcer-em');
    expect(strong).not.toBeNull();
    expect(strong?.textContent).toBe('export bug');
    // The spoken/visible text is intact — emphasis is presentation only.
    expect(el.textContent).toBe('fixed the export bug');
  });

  it('emphasizes multiple phrases', () => {
    const el = document.createElement('p');
    renderScript(el, 'fixed the export bug and added tests', ['export bug', 'added tests']);
    const strongs = [...el.querySelectorAll('strong.announcer-em')].map(s => s.textContent);
    expect(strongs).toEqual(['export bug', 'added tests']);
    expect(el.textContent).toBe('fixed the export bug and added tests');
  });

  it('ignores an emphasis phrase that is not a verbatim substring', () => {
    const el = document.createElement('p');
    renderScript(el, 'fixed the export bug', ['nonexistent phrase']);
    expect(el.querySelector('.announcer-em')).toBeNull();
    expect(el.textContent).toBe('fixed the export bug');
  });
});
