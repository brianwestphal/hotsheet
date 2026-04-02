import { describe, expect, it } from 'vitest';

import { escapeAttr,escapeHtml } from './escapeHtml.js';

describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than signs', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  it('escapes greater-than signs', () => {
    expect(escapeHtml('1 > 0')).toBe('1 &gt; 0');
  });

  it('escapes double quotes', () => {
    expect(escapeHtml('say "hello"')).toBe('say &quot;hello&quot;');
  });

  it('does not escape single quotes', () => {
    expect(escapeHtml("it's fine")).toBe("it's fine");
  });

  it('escapes all special characters in one string', () => {
    expect(escapeHtml('<div class="x">&</div>')).toBe(
      '&lt;div class=&quot;x&quot;&gt;&amp;&lt;/div&gt;',
    );
  });

  it('returns empty string unchanged', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('returns plain text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('handles multiple ampersands', () => {
    expect(escapeHtml('a&&b&&c')).toBe('a&amp;&amp;b&amp;&amp;c');
  });
});

describe('escapeAttr', () => {
  it('escapes ampersands', () => {
    expect(escapeAttr('a & b')).toBe('a &amp; b');
  });

  it('escapes double quotes', () => {
    expect(escapeAttr('say "hi"')).toBe('say &quot;hi&quot;');
  });

  it('escapes single quotes', () => {
    expect(escapeAttr("it's")).toBe('it&#39;s');
  });

  it('escapes less-than signs', () => {
    expect(escapeAttr('x < y')).toBe('x &lt; y');
  });

  it('escapes greater-than signs', () => {
    expect(escapeAttr('x > y')).toBe('x &gt; y');
  });

  it('escapes all special characters in one string', () => {
    expect(escapeAttr(`"it's" <&>`)).toBe('&quot;it&#39;s&quot; &lt;&amp;&gt;');
  });

  it('returns empty string unchanged', () => {
    expect(escapeAttr('')).toBe('');
  });

  it('returns plain text unchanged', () => {
    expect(escapeAttr('hello world')).toBe('hello world');
  });
});
