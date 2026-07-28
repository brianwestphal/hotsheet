/**
 * HS-9450 — the `#jsx` SEAM's own test.
 *
 * `jsx-runtime.ts` is no longer an implementation; it re-exports kerf's runtime. So
 * what this file is for now is the seam itself: that every symbol the ~46 consuming
 * modules import (`SafeHtml` / `raw` / `jsx` / `jsxs` / `Fragment`) is exported and
 * behaves, through OUR module path rather than kerf's.
 *
 * Rendering BEHAVIOR — the attribute-name mapping, escaping, child shapes, void
 * tags — belongs to `jsxRuntimeCorpus.test.ts`, which is the §62 equivalence corpus
 * and the thing that proved the swap byte-identical. Prefer adding cases there.
 *
 * Assertions read `.toString()` rather than `.__html`: kerf's `SafeHtml` happens to
 * expose `__html` too (which is why these passed unchanged across the swap), but
 * `toString()` is the documented contract and the one a future implementation is
 * obliged to keep.
 */
import { Fragment,jsx, jsxs, raw, SafeHtml } from 'kerfjs/jsx-runtime';
import { describe, expect, it } from 'vitest';

describe('SafeHtml', () => {
  it('stores raw HTML string', () => {
    const html = new SafeHtml('<div>hello</div>');
    expect(html.toString()).toBe('<div>hello</div>');
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
    expect(result.toString()).toBe('<b>bold & "quoted"</b>');
  });
});

describe('jsx — element creation', () => {
  it('renders a simple element with no children', () => {
    const result = jsx('div', {});
    expect(result.toString()).toBe('<div></div>');
  });

  it('renders a string child with HTML escaping', () => {
    const result = jsx('p', { children: '<script>alert("xss")</script>' });
    expect(result.toString()).toBe('<p>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</p>');
  });

  it('renders a number child without escaping', () => {
    const result = jsx('span', { children: 42 });
    expect(result.toString()).toBe('<span>42</span>');
  });

  it('renders boolean children as empty', () => {
    expect(jsx('span', { children: true }).toString()).toBe('<span></span>');
    expect(jsx('span', { children: false }).toString()).toBe('<span></span>');
  });

  it('renders null and undefined children as empty', () => {
    expect(jsx('span', { children: null }).toString()).toBe('<span></span>');
    expect(jsx('span', { children: undefined }).toString()).toBe('<span></span>');
  });

  it('renders SafeHtml children without double-escaping', () => {
    const inner = raw('<em>already safe</em>');
    const result = jsx('div', { children: inner });
    expect(result.toString()).toBe('<div><em>already safe</em></div>');
  });

  it('renders an array of children', () => {
    const result = jsxs('ul', {
      children: [
        jsx('li', { children: 'one' }),
        jsx('li', { children: 'two' }),
      ],
    });
    expect(result.toString()).toBe('<ul><li>one</li><li>two</li></ul>');
  });

  it('renders mixed child types in an array', () => {
    const result = jsxs('p', {
      children: ['Hello ', jsx('b', { children: 'world' }), '!'],
    });
    expect(result.toString()).toBe('<p>Hello <b>world</b>!</p>');
  });

  it('renders nested arrays of children', () => {
    const result = jsx('div', {
      children: [['a', 'b'], ['c']],
    });
    expect(result.toString()).toBe('<div>abc</div>');
  });

  it('skips null/boolean/undefined in child arrays', () => {
    const result = jsx('div', {
      children: ['text', null, false, undefined, true, 0],
    });
    expect(result.toString()).toBe('<div>text0</div>');
  });
});

describe('jsx — attributes', () => {
  it('renders string attributes with escaping', () => {
    const result = jsx('a', { href: '/path?a=1&b=2', children: 'link' });
    expect(result.toString()).toBe('<a href="/path?a=1&amp;b=2">link</a>');
  });

  it('renders number attributes', () => {
    const result = jsx('input', { tabIndex: 3 });
    expect(result.toString()).toBe('<input tabindex="3">');
  });

  it('renders boolean true attribute as valueless', () => {
    const result = jsx('input', { disabled: true });
    expect(result.toString()).toBe('<input disabled>');
  });

  it('omits boolean false attributes', () => {
    const result = jsx('input', { disabled: false });
    expect(result.toString()).toBe('<input>');
  });

  it('omits null/undefined attributes', () => {
    const result = jsx('div', { id: null, title: undefined });
    expect(result.toString()).toBe('<div></div>');
  });

  it('maps className to class', () => {
    const result = jsx('div', { className: 'foo bar' });
    expect(result.toString()).toBe('<div class="foo bar"></div>');
  });

  it('maps htmlFor to for', () => {
    const result = jsx('label', { htmlFor: 'email', children: 'Email' });
    expect(result.toString()).toBe('<label for="email">Email</label>');
  });

  it('escapes special characters in attribute values', () => {
    const result = jsx('div', { title: 'He said "hello" & <goodbye>' });
    expect(result.toString()).toBe('<div title="He said &quot;hello&quot; &amp; &lt;goodbye&gt;"></div>');
  });

  it('accepts SafeHtml as an attribute value (no escaping)', () => {
    const result = jsx('div', { 'data-html': raw('<b>bold</b>') });
    expect(result.toString()).toBe('<div data-html="<b>bold</b>"></div>');
  });

  // HS-7997 — `spellCheck` is the JSX/React-style camelCase name for the HTML
  // `spellcheck` attribute; without the mapping it would render as `spellCheck=`,
  // which most browsers tolerate but isn't the standard attribute name. Kept after
  // HS-9450 swapped the local alias table for kerf's: it proves kerf preserves the
  // mapping, so system spell check on the title / details / notes fields can't
  // silently regress on a kerf bump.
  //
  // NOTE the .tsx call sites now write the LOWERCASE `spellcheck="true"`. kerf types
  // camelCase `spellCheck` as `AttrLike<boolean>` (it's an enumerated attribute, so
  // that's too narrow) while explicitly widening the lowercase form to accept
  // `'true'`/`'false'`. Both render identically — this test pins the camelCase path,
  // the corpus pins the lowercase one.
  it('maps spellCheck to spellcheck (HS-7997)', () => {
    expect(jsx('input', { type: 'text', spellCheck: 'true' }).toString())
      .toBe('<input type="text" spellcheck="true">');
    expect(jsx('textarea', { spellCheck: 'true', rows: 3 }).toString())
      .toBe('<textarea spellcheck="true" rows="3"></textarea>');
  });
});

describe('jsx — void tags', () => {
  it('renders void tags as self-closing (no closing tag)', () => {
    expect(jsx('br', {}).toString()).toBe('<br>');
    expect(jsx('hr', {}).toString()).toBe('<hr>');
    expect(jsx('img', { src: '/logo.png', alt: 'logo' }).toString()).toBe('<img src="/logo.png" alt="logo">');
    expect(jsx('input', { type: 'text', name: 'q' }).toString()).toBe('<input type="text" name="q">');
  });

  it('ignores children on void tags', () => {
    const result = jsx('br', { children: 'should be ignored' });
    expect(result.toString()).toBe('<br>');
  });
});

describe('jsx — component functions', () => {
  it('calls a function component with props', () => {
    function Greeting(props: { name: string }) {
      return jsx('span', { children: `Hello ${props.name}` });
    }
    const result = jsx(Greeting as (props: Record<string, unknown>) => SafeHtml, { name: 'World' });
    expect(result.toString()).toBe('<span>Hello World</span>');
  });

  it('passes children to function components', () => {
    function Wrapper(props: { children?: SafeHtml | string }) {
      return jsx('div', { className: 'wrapper', children: props.children });
    }
    // Wrapper's all-optional props are narrower than jsx()'s Props (whose
    // `children` includes null + an index signature), so the component type
    // must be forced — `tsc` errors (TS2345) if this assertion is removed.
    // typescript-eslint 8.60.0 nonetheless reports it as unnecessary (a
    // false-positive specific to all-optional-param bivariance; the identical
    // cast on `Greeting` above is correctly left alone), so suppress it here.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const result = jsx(Wrapper as (props: Record<string, unknown>) => SafeHtml, { children: jsx('p', { children: 'inside' }) });
    expect(result.toString()).toBe('<div class="wrapper"><p>inside</p></div>');
  });
});

describe('Fragment', () => {
  it('renders children without a wrapper element', () => {
    const result = Fragment({ children: [jsx('li', { children: 'a' }), jsx('li', { children: 'b' })] });
    expect(result.toString()).toBe('<li>a</li><li>b</li>');
  });

  it('renders empty when no children', () => {
    expect(Fragment({}).toString()).toBe('');
    expect(Fragment({ children: undefined }).toString()).toBe('');
  });

  it('renders a single string child with escaping', () => {
    const result = Fragment({ children: 'plain & simple' });
    expect(result.toString()).toBe('plain &amp; simple');
  });
});

describe('jsxs is an alias for jsx', () => {
  it('produces the same output as jsx', () => {
    const a = jsx('div', { className: 'x', children: 'y' });
    const b = jsxs('div', { className: 'x', children: 'y' });
    expect(a.toString()).toBe(b.toString());
  });
});
