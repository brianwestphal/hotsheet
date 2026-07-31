/**
 * HS-9450 (§62) — the JSX render-target equivalence corpus.
 *
 * §62 originally scoped "a ~50-case corpus asserting the render targets agree" and
 * then never built it, because the SVG bug class got closed a cheaper way (routing
 * `toElement` through kerf). Replacing Hot Sheet's hand-rolled runtime with kerf's
 * is exactly the change that corpus was meant to protect, so it gets built now.
 *
 * These assert EXACT output rather than comparing two runtimes against each other.
 * That is what made them useful: every case was written and passing against the OLD
 * local runtime first, and then had to pass VERBATIM against kerf's. All 77 did — the
 * swap changed no rendered byte. A runtime-vs-runtime comparison would have been
 * deleted the moment the old one went; a golden corpus survives and now guards every
 * future kerf bump.
 *
 * Cases are drawn from what this codebase actually renders: every entry of the old
 * `ATTR_ALIASES` table (HTML + SVG), the already-correctly-cased SVG attributes that
 * must NOT be rewritten, void tags, every child shape, and the escaping boundary
 * (`raw()` / `SafeHtml` pass through, strings do not).
 *
 * `draggable` used to be uncoverable here: kerf typed it as a boolean, and rendering
 * it as one produced markup meaning the opposite. **kerf 4.0 fixed that** (HS-9373) —
 * `draggable`/`spellCheck`/`contentEditable` are now typed as the enumerated
 * attributes they are, so the boolean form no longer compiles and the
 * `DRAGGABLE_TRUE` workaround is gone. `projectTabs.test.ts` still asserts the
 * rendered attribute value, which is the guard that matters.
 */
import type { SafeHtml } from 'kerfjs';
import { Fragment, jsx, jsxs, raw } from 'kerfjs/jsx-runtime';
import { describe, expect, it } from 'vitest';

/** Render an intrinsic element the way the compiled JSX transform would. */
const el = (tag: string, props: Record<string, unknown> = {}): string =>
  String((jsx as (t: string, p: Record<string, unknown>) => SafeHtml)(tag, props));

describe('JSX corpus — attribute name mapping (HTML)', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['className → class', { className: 'a b' }, '<div class="a b"></div>'],
    ['htmlFor → for', { htmlFor: 'x' }, '<div for="x"></div>'],
    ['httpEquiv → http-equiv', { httpEquiv: 'refresh' }, '<div http-equiv="refresh"></div>'],
    ['acceptCharset → accept-charset', { acceptCharset: 'utf-8' }, '<div accept-charset="utf-8"></div>'],
    ['autoComplete → autocomplete', { autoComplete: 'off' }, '<div autocomplete="off"></div>'],
    ['contentEditable → contenteditable', { contentEditable: 'true' }, '<div contenteditable="true"></div>'],
    ['colSpan → colspan', { colSpan: 2 }, '<div colspan="2"></div>'],
    ['dateTime → datetime', { dateTime: '2026' }, '<div datetime="2026"></div>'],
    ['defaultChecked → checked', { defaultChecked: true }, '<div checked></div>'],
    ['defaultValue → value', { defaultValue: 'v' }, '<div value="v"></div>'],
    ['maxLength → maxlength', { maxLength: 5 }, '<div maxlength="5"></div>'],
    ['readOnly → readonly', { readOnly: true }, '<div readonly></div>'],
    ['rowSpan → rowspan', { rowSpan: 3 }, '<div rowspan="3"></div>'],
    ['spellCheck → spellcheck', { spellCheck: 'false' }, '<div spellcheck="false"></div>'],
    ['srcDoc → srcdoc', { srcDoc: '<p>x</p>' }, '<div srcdoc="&lt;p&gt;x&lt;/p&gt;"></div>'],
    ['tabIndex → tabindex', { tabIndex: -1 }, '<div tabindex="-1"></div>'],
  ];
  for (const [label, props, expected] of cases) {
    it(label, () => { expect(el('div', props)).toBe(expected); });
  }
});

describe('JSX corpus — attribute name mapping (SVG)', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['strokeWidth → stroke-width', { strokeWidth: 2 }, '<path stroke-width="2"></path>'],
    ['strokeLinecap → stroke-linecap', { strokeLinecap: 'round' }, '<path stroke-linecap="round"></path>'],
    ['strokeLinejoin → stroke-linejoin', { strokeLinejoin: 'miter' }, '<path stroke-linejoin="miter"></path>'],
    ['strokeDasharray → stroke-dasharray', { strokeDasharray: '2 2' }, '<path stroke-dasharray="2 2"></path>'],
    ['fillRule → fill-rule', { fillRule: 'evenodd' }, '<path fill-rule="evenodd"></path>'],
    ['clipPath → clip-path', { clipPath: 'url(#c)' }, '<path clip-path="url(#c)"></path>'],
    ['fontFamily → font-family', { fontFamily: 'mono' }, '<path font-family="mono"></path>'],
    ['textAnchor → text-anchor', { textAnchor: 'middle' }, '<path text-anchor="middle"></path>'],
    ['dominantBaseline → dominant-baseline', { dominantBaseline: 'middle' }, '<path dominant-baseline="middle"></path>'],
    ['pointerEvents → pointer-events', { pointerEvents: 'none' }, '<path pointer-events="none"></path>'],
    ['xlinkHref → xlink:href', { xlinkHref: '#a' }, '<path xlink:href="#a"></path>'],
    ['xmlnsXlink → xmlns:xlink', { xmlnsXlink: 'ns' }, '<path xmlns:xlink="ns"></path>'],
    // Attributes that are ALREADY correctly cased must survive untouched — the
    // camelCase→kebab mapping is a lookup table, not a transform.
    ['viewBox stays camelCase', { viewBox: '0 0 1 1' }, '<path viewBox="0 0 1 1"></path>'],
    ['gradientUnits stays camelCase', { gradientUnits: 'userSpaceOnUse' }, '<path gradientUnits="userSpaceOnUse"></path>'],
    ['stdDeviation stays camelCase', { stdDeviation: 2 }, '<path stdDeviation="2"></path>'],
    ['preserveAspectRatio stays camelCase', { preserveAspectRatio: 'none' }, '<path preserveAspectRatio="none"></path>'],
  ];
  for (const [label, props, expected] of cases) {
    it(label, () => { expect(el('path', props)).toBe(expected); });
  }
});

describe('JSX corpus — attribute values', () => {
  it('true renders a bare attribute', () => { expect(el('input', { disabled: true })).toBe('<input disabled>'); });
  it('false omits the attribute entirely', () => { expect(el('input', { disabled: false })).toBe('<input>'); });
  it('null omits the attribute', () => { expect(el('div', { title: null })).toBe('<div></div>'); });
  it('undefined omits the attribute', () => { expect(el('div', { title: undefined })).toBe('<div></div>'); });
  it('numbers stringify', () => { expect(el('div', { 'data-n': 42 })).toBe('<div data-n="42"></div>'); });
  it('zero is kept (not treated as falsy)', () => { expect(el('div', { 'data-n': 0 })).toBe('<div data-n="0"></div>'); });
  it('empty string is kept', () => { expect(el('div', { title: '' })).toBe('<div title=""></div>'); });
  it('string values are attribute-escaped', () => {
    expect(el('div', { title: 'a "b" & <c>' })).toBe('<div title="a &quot;b&quot; &amp; &lt;c&gt;"></div>');
  });
  it('SafeHtml attribute values pass through UNescaped (the raw() escape hatch)', () => {
    expect(el('div', { title: raw('a&b') })).toBe('<div title="a&b"></div>');
  });
  it('data-* and aria-* names pass through verbatim', () => {
    expect(el('div', { 'data-key': '1', 'aria-label': 'x' })).toBe('<div data-key="1" aria-label="x"></div>');
  });
  it('attribute order follows prop order', () => {
    expect(el('div', { b: '1', a: '2' })).toBe('<div b="1" a="2"></div>');
  });
});

describe('JSX corpus — void tags', () => {
  for (const tag of ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']) {
    it(`<${tag}> self-closes with no end tag`, () => { expect(el(tag)).toBe(`<${tag}>`); });
  }
  it('a void tag still renders its attributes', () => {
    expect(el('img', { src: '/a.png', alt: 'x' })).toBe('<img src="/a.png" alt="x">');
  });
  it('a non-void tag emits an end tag when empty', () => { expect(el('div')).toBe('<div></div>'); });
  it('children on a void tag are dropped', () => {
    expect(el('br', { children: 'x' })).toBe('<br>');
  });
});

describe('JSX corpus — children', () => {
  it('string children are HTML-escaped', () => {
    expect(el('p', { children: '<script>alert("x")</script>' }))
      .toBe('<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>');
  });
  it('ampersands in text are escaped', () => { expect(el('p', { children: 'a & b' })).toBe('<p>a &amp; b</p>'); });
  it('number children stringify without escaping', () => { expect(el('span', { children: 42 })).toBe('<span>42</span>'); });
  it('zero renders (not dropped as falsy)', () => { expect(el('span', { children: 0 })).toBe('<span>0</span>'); });
  it('null children render nothing', () => { expect(el('div', { children: null })).toBe('<div></div>'); });
  it('undefined children render nothing', () => { expect(el('div', { children: undefined })).toBe('<div></div>'); });
  it('boolean children render nothing (the `cond && <x/>` idiom)', () => {
    expect(el('div', { children: false })).toBe('<div></div>');
    expect(el('div', { children: true })).toBe('<div></div>');
  });
  it('array children concatenate with no separator', () => {
    expect(el('div', { children: ['a', 'b'] })).toBe('<div>ab</div>');
  });
  it('nested arrays flatten', () => {
    expect(el('div', { children: [['a', ['b']], 'c'] })).toBe('<div>abc</div>');
  });
  it('mixed arrays drop the nullish entries', () => {
    expect(el('div', { children: ['a', null, undefined, false, 'b'] })).toBe('<div>ab</div>');
  });
  it('SafeHtml children pass through unescaped', () => {
    expect(el('div', { children: raw('<b>x</b>') })).toBe('<div><b>x</b></div>');
  });
  it('nested elements compose', () => {
    const inner = (jsx as (t: string, p: Record<string, unknown>) => SafeHtml)('b', { children: 'x' });
    expect(el('div', { children: inner })).toBe('<div><b>x</b></div>');
  });
});

describe('JSX corpus — Fragment and components', () => {
  it('Fragment renders only its children', () => {
    expect(String(jsxs(Fragment as never, { children: ['a', 'b'] }))).toBe('ab');
  });
  it('an empty Fragment renders nothing', () => {
    expect(String(jsx(Fragment as never, {}))).toBe('');
  });
  it('a function component receives children through props', () => {
    const Wrap = (p: { children?: unknown }): SafeHtml =>
      (jsx as (t: string, x: Record<string, unknown>) => SafeHtml)('div', { children: p.children });
    expect(String((jsx as (t: unknown, p: unknown) => SafeHtml)(Wrap, { children: 'x' }))).toBe('<div>x</div>');
  });
  it('a function component is called with its props', () => {
    const Comp = (p: { name: string }): SafeHtml => (jsx as (t: string, x: Record<string, unknown>) => SafeHtml)('b', { children: p.name });
    expect(String((jsx as (t: unknown, p: unknown) => SafeHtml)(Comp, { name: 'hi' }))).toBe('<b>hi</b>');
  });
});

describe('JSX corpus — SafeHtml contract', () => {
  it('toString() returns the markup', () => {
    expect((jsx as (t: string, p: Record<string, unknown>) => SafeHtml)('div', { children: 'x' }).toString())
      .toBe('<div>x</div>');
  });
  it('raw() marks a string as already-safe', () => {
    expect(raw('<em>x</em>').toString()).toBe('<em>x</em>');
  });
  it('string interpolation of a rendered element yields its markup', () => {
    expect(el('i', { children: 'x' })).toBe('<i>x</i>');
  });
});

describe('JSX corpus — the DOM-node-as-child guard (HS-6341)', () => {
  it('throws when a DOM-like object is passed as a child', () => {
    const fakeNode = { nodeType: 1, outerHTML: '<div></div>' };
    expect(() => el('div', { children: fakeNode })).toThrow(/DOM elements cannot be passed as children/);
  });
});
