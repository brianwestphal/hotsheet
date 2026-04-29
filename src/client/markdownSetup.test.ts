import './markdownSetup.js';

import { marked } from 'marked';
import { describe, expect, it } from 'vitest';

describe('markdownSetup (HS-7855 / HS-7857)', () => {
  it('escapes a stray `<span class=foo>` tag instead of rendering it raw', () => {
    // Real-world note pulled from HS-7857 — a bare `<span class=hide-btn-badge>`
    // mention used to leak through and become an absolutely-positioned blue
    // badge element that captured every following character as a child.
    const note = 'renders/removes a <span class=hide-btn-badge> child idempotently with a 99+ cap.';
    const html = marked.parse(note, { async: false });
    expect(html).not.toMatch(/<span class=hide-btn-badge>/);
    expect(html).toContain('&lt;span class=hide-btn-badge&gt;');
  });

  it('escapes `<input>` tags that show up unescaped in completion notes (HS-7855)', () => {
    const note = 'replaced the plain <input type=text> in openEditor with <input list> + <datalist>.';
    const html = marked.parse(note, { async: false });
    expect(html).not.toMatch(/<input(?:\s|>)/);
    expect(html).toContain('&lt;input type=text&gt;');
    expect(html).toContain('&lt;input list&gt;');
    expect(html).toContain('&lt;datalist&gt;');
  });

  it('escapes block-level raw HTML too (e.g. a stray `<style>` or `<table>`)', () => {
    const note = '<style>body { background: red; }</style>';
    const html = marked.parse(note, { async: false });
    expect(html).not.toMatch(/<style>/i);
    expect(html).toContain('&lt;style&gt;');
  });

  it('still renders markdown-native syntax (links, code, bold) normally', () => {
    const html = marked.parse('Visit [example](https://example.com) — **bold** and `code`.', { async: false });
    expect(html).toContain('<a href="https://example.com">example</a>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
  });

  it('keeps `breaks: true` behavior — a single newline becomes <br>', () => {
    const html = marked.parse('line one\nline two', { async: false });
    expect(html).toMatch(/<br\s*\/?>/);
  });

  // HS-7994 — GFM tables render as a real <table> with <th>/<td>; if marked
  // ever stops emitting these (or someone disables the gfm option) the
  // `.note-markdown table` styles in styles.scss have nothing to attach to,
  // so the spacing-and-overflow fix silently regresses. Lock the contract
  // here so a future config change trips the test.
  it('renders GFM tables as <table>/<th>/<td> so the .note-markdown table styles apply (HS-7994)', () => {
    const md = [
      '| keyword     | painted | resolved |',
      '|-------------|---------|----------|',
      '| serif       | 8.0     | Times    |',
      '| sans-serif  | 8.91    | Helvetica|',
    ].join('\n');
    const html = marked.parse(md, { async: false });
    expect(html).toMatch(/<table[^>]*>/);
    expect(html).toMatch(/<thead[^>]*>[\s\S]*<th[^>]*>\s*keyword\s*<\/th>/);
    expect(html).toMatch(/<tbody[^>]*>[\s\S]*<td[^>]*>\s*serif\s*<\/td>/);
  });
});
