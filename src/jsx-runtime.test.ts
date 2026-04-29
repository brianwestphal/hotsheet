import { describe, expect, it } from 'vitest';

import { Fragment,jsx, jsxs, raw, SafeHtml } from './jsx-runtime.js';

describe('SafeHtml', () => {
  it('stores raw HTML string', () => {
    const html = new SafeHtml('<div>hello</div>');
    expect(html.__html).toBe('<div>hello</div>');
  });

  it('toString returns the raw HTML', () => {
    const html = new SafeHtml('<p>test</p>');
    expect(html.toString()).toBe('<p>test</p>');
    expect(`${html}`).toBe('<p>test</p>');
  });
});

describe('raw', () => {
  it('wraps a string in SafeHtml without escaping', () => {
    const result = raw('<b>bold & "quoted"</b>');
    expect(result).toBeInstanceOf(SafeHtml);
    expect(result.__html).toBe('<b>bold & "quoted"</b>');
  });
});

describe('jsx — element creation', () => {
  it('renders a simple element with no children', () => {
    const result = jsx('div', {});
    expect(result.__html).toBe('<div></div>');
  });

  it('renders a string child with HTML escaping', () => {
    const result = jsx('p', { children: '<script>alert("xss")</script>' });
    expect(result.__html).toBe('<p>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</p>');
  });

  it('renders a number child without escaping', () => {
    const result = jsx('span', { children: 42 });
    expect(result.__html).toBe('<span>42</span>');
  });

  it('renders boolean children as empty', () => {
    expect(jsx('span', { children: true }).__html).toBe('<span></span>');
    expect(jsx('span', { children: false }).__html).toBe('<span></span>');
  });

  it('renders null and undefined children as empty', () => {
    expect(jsx('span', { children: null }).__html).toBe('<span></span>');
    expect(jsx('span', { children: undefined }).__html).toBe('<span></span>');
  });

  it('renders SafeHtml children without double-escaping', () => {
    const inner = raw('<em>already safe</em>');
    const result = jsx('div', { children: inner });
    expect(result.__html).toBe('<div><em>already safe</em></div>');
  });

  it('renders an array of children', () => {
    const result = jsxs('ul', {
      children: [
        jsx('li', { children: 'one' }),
        jsx('li', { children: 'two' }),
      ],
    });
    expect(result.__html).toBe('<ul><li>one</li><li>two</li></ul>');
  });

  it('renders mixed child types in an array', () => {
    const result = jsxs('p', {
      children: ['Hello ', jsx('b', { children: 'world' }), '!'],
    });
    expect(result.__html).toBe('<p>Hello <b>world</b>!</p>');
  });

  it('renders nested arrays of children', () => {
    const result = jsx('div', {
      children: [['a', 'b'], ['c']],
    });
    expect(result.__html).toBe('<div>abc</div>');
  });

  it('skips null/boolean/undefined in child arrays', () => {
    const result = jsx('div', {
      children: ['text', null, false, undefined, true, 0],
    });
    expect(result.__html).toBe('<div>text0</div>');
  });
});

describe('jsx — attributes', () => {
  it('renders string attributes with escaping', () => {
    const result = jsx('a', { href: '/path?a=1&b=2', children: 'link' });
    expect(result.__html).toBe('<a href="/path?a=1&amp;b=2">link</a>');
  });

  it('renders number attributes', () => {
    const result = jsx('input', { tabIndex: 3 });
    expect(result.__html).toBe('<input tabindex="3">');
  });

  it('renders boolean true attribute as valueless', () => {
    const result = jsx('input', { disabled: true });
    expect(result.__html).toBe('<input disabled>');
  });

  it('omits boolean false attributes', () => {
    const result = jsx('input', { disabled: false });
    expect(result.__html).toBe('<input>');
  });

  it('omits null/undefined attributes', () => {
    const result = jsx('div', { id: null, title: undefined });
    expect(result.__html).toBe('<div></div>');
  });

  it('maps className to class', () => {
    const result = jsx('div', { className: 'foo bar' });
    expect(result.__html).toBe('<div class="foo bar"></div>');
  });

  it('maps htmlFor to for', () => {
    const result = jsx('label', { htmlFor: 'email', children: 'Email' });
    expect(result.__html).toBe('<label for="email">Email</label>');
  });

  it('escapes special characters in attribute values', () => {
    const result = jsx('div', { title: 'He said "hello" & <goodbye>' });
    expect(result.__html).toBe('<div title="He said &quot;hello&quot; &amp; &lt;goodbye&gt;"></div>');
  });

  it('accepts SafeHtml as an attribute value (no escaping)', () => {
    const result = jsx('div', { 'data-html': raw('<b>bold</b>') });
    expect(result.__html).toBe('<div data-html="<b>bold</b>"></div>');
  });

  // HS-7997 — `spellCheck` is the JSX/React-style camelCase name for the
  // HTML `spellcheck` attribute. The alias map at line 83 of
  // `jsx-runtime.ts` translates the prop name; without it the attribute
  // would render as `spellCheck="true"` (camelCase), which most browsers
  // tolerate but is technically not the standard HTML attribute and
  // breaks consistency. Lock the mapping with a test so a future alias
  // refactor doesn't silently regress system spell check on the title /
  // details / notes textareas.
  it('maps spellCheck to spellcheck (HS-7997)', () => {
    expect(jsx('input', { type: 'text', spellCheck: 'true' }).__html)
      .toBe('<input type="text" spellcheck="true">');
    expect(jsx('textarea', { spellCheck: 'true', rows: 3 }).__html)
      .toBe('<textarea spellcheck="true" rows="3"></textarea>');
  });
});

describe('jsx — void tags', () => {
  it('renders void tags as self-closing (no closing tag)', () => {
    expect(jsx('br', {}).__html).toBe('<br>');
    expect(jsx('hr', {}).__html).toBe('<hr>');
    expect(jsx('img', { src: '/logo.png', alt: 'logo' }).__html).toBe('<img src="/logo.png" alt="logo">');
    expect(jsx('input', { type: 'text', name: 'q' }).__html).toBe('<input type="text" name="q">');
  });

  it('ignores children on void tags', () => {
    const result = jsx('br', { children: 'should be ignored' });
    expect(result.__html).toBe('<br>');
  });
});

describe('jsx — component functions', () => {
  it('calls a function component with props', () => {
    function Greeting(props: { name: string }) {
      return jsx('span', { children: `Hello ${props.name}` });
    }
    const result = jsx(Greeting as (props: Record<string, unknown>) => SafeHtml, { name: 'World' });
    expect(result.__html).toBe('<span>Hello World</span>');
  });

  it('passes children to function components', () => {
    function Wrapper(props: { children?: SafeHtml | string }) {
      return jsx('div', { className: 'wrapper', children: props.children });
    }
    const result = jsx(Wrapper as (props: Record<string, unknown>) => SafeHtml, { children: jsx('p', { children: 'inside' }) });
    expect(result.__html).toBe('<div class="wrapper"><p>inside</p></div>');
  });
});

describe('Fragment', () => {
  it('renders children without a wrapper element', () => {
    const result = Fragment({ children: [jsx('li', { children: 'a' }), jsx('li', { children: 'b' })] });
    expect(result.__html).toBe('<li>a</li><li>b</li>');
  });

  it('renders empty when no children', () => {
    expect(Fragment({}).__html).toBe('');
    expect(Fragment({ children: undefined }).__html).toBe('');
  });

  it('renders a single string child with escaping', () => {
    const result = Fragment({ children: 'plain & simple' });
    expect(result.__html).toBe('plain &amp; simple');
  });
});

describe('jsxs is an alias for jsx', () => {
  it('produces the same output as jsx', () => {
    const a = jsx('div', { className: 'x', children: 'y' });
    const b = jsxs('div', { className: 'x', children: 'y' });
    expect(a.__html).toBe(b.__html);
  });
});
