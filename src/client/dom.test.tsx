// @vitest-environment happy-dom
/**
 * HS-8092 — unit tests for `requireChild`. The helper replaces six
 * `root.querySelector(selector)!` non-null assertions in dialog code
 * (`feedbackDialog.tsx`, `readerOverlay.tsx`) with a typed lookup that
 * throws a descriptive error when the selector misses — so JSX-template
 * drift surfaces at the click handler's wiring time rather than as a
 * useless `Cannot read properties of null` deeper in the call stack.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { raw, SafeHtml } from '../jsx-runtime.js';
import { byId, byIdOrNull, requireChild, toElement } from './dom.js';

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { document.body.innerHTML = ''; });

describe('requireChild (HS-8092)', () => {
  it('returns the element when the selector matches', () => {
    const root = document.createElement('div');
    // HS-8467 — TSX fixture instead of `innerHTML = '<html-string>'`.
    root.replaceChildren(toElement(<button id="ok" className="primary">click me</button>));
    const btn = requireChild<HTMLButtonElement>(root, '#ok');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.id).toBe('ok');
    // The generic constraint preserves the concrete type — `disabled`
    // would not be on the default `HTMLElement` return.
    btn.disabled = true;
    expect(btn.disabled).toBe(true);
  });

  it('returns the FIRST match for selectors that resolve multiple', () => {
    const root = document.createElement('div');
    root.replaceChildren(toElement(<button>a</button>), toElement(<button>b</button>));
    expect(requireChild<HTMLButtonElement>(root, 'button').textContent).toBe('a');
  });

  it('throws with the selector + a descriptive root tag when the selector misses', () => {
    const root = document.createElement('div');
    root.id = 'feedback-overlay';
    root.className = 'permission-popup';
    root.replaceChildren(toElement(<span>nothing matching</span>));
    expect(() => requireChild(root, '#missing-id')).toThrow(/no match for "#missing-id"/);
    expect(() => requireChild(root, '#missing-id')).toThrow(/<div id="feedback-overlay" class="permission-popup">/);
  });

  it('falls back to "document" in the error message when the root is the document itself', () => {
    expect(() => requireChild(document, '#absent')).toThrow(/no match for "#absent" in document/);
  });

  it('handles unclassed / un-id-ed roots in the error message without throwing on the description build', () => {
    const root = document.createElement('section');
    expect(() => requireChild(root, '.x')).toThrow(/<section>/);
  });

  it('defaults the return type to HTMLElement when no generic is supplied', () => {
    const root = document.createElement('div');
    root.replaceChildren(toElement(<p>hi</p>));
    const el = requireChild(root, 'p');
    // Type-level assertion: `el` is `HTMLElement` so this access compiles.
    el.style.color = 'red';
    expect(el.style.color).toBe('red');
  });
});

describe('byId / byIdOrNull (HS-8083)', () => {
  it('byId returns the element when the id matches', () => {
    document.body.replaceChildren(toElement(<input id="foo" type="text" />));
    const el = byId<HTMLInputElement>('foo');
    expect(el.tagName).toBe('INPUT');
    el.value = 'hello';
    expect(el.value).toBe('hello');
  });

  it('byId throws with a descriptive message when the id is missing', () => {
    document.body.innerHTML = '';
    expect(() => byId('absent-id')).toThrow(/no element with id "absent-id"/);
  });

  it('byId defaults to HTMLElement when no generic is supplied', () => {
    document.body.replaceChildren(toElement(<div id="bar"></div>));
    const el = byId('bar');
    el.style.color = 'red';
    expect(el.style.color).toBe('red');
  });

  it('byIdOrNull returns the element when present', () => {
    document.body.replaceChildren(toElement(<button id="b"></button>));
    expect(byIdOrNull<HTMLButtonElement>('b')?.tagName).toBe('BUTTON');
  });

  it('byIdOrNull returns null when missing (no throw)', () => {
    document.body.innerHTML = '';
    expect(byIdOrNull('absent')).toBeNull();
  });
});

describe('toElement (HS-8241 — kerf swap)', () => {
  it('produces an HTMLElement for plain HTML JSX (the dominant case)', () => {
    const el = toElement(new SafeHtml('<div class="x">hi</div>'));
    expect(el.tagName).toBe('DIV');
    expect(el.className).toBe('x');
    expect(el.textContent).toBe('hi');
  });

  it('preserves children + attributes through the round-trip', () => {
    const el = toElement(new SafeHtml('<button data-x="1" disabled><span>label</span></button>'));
    expect(el.tagName).toBe('BUTTON');
    expect(el.dataset.x).toBe('1');
    expect(el.hasAttribute('disabled')).toBe(true);
    expect(el.firstElementChild?.tagName).toBe('SPAN');
    expect(el.firstElementChild?.textContent).toBe('label');
  });

  it('SVG inside an HTML wrapper via raw() — the standard Hot Sheet icon pattern — produces an HTML root with the SVG nested correctly', () => {
    // This is what every `<span>{raw(ICON_X)}</span>` callsite produces.
    // The OUTER element is an HTML span; the SVG lives inside.
    const svgIcon = raw('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0L24 24"/></svg>');
    const el = toElement(<span className="icon-host">{svgIcon}</span>);
    expect(el.tagName).toBe('SPAN');
    expect(el.className).toBe('icon-host');
    const svg = el.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.querySelector('path')?.getAttribute('d')).toBe('M0 0L24 24');
  });

  it('SVG root passed directly to toElement now produces a proper SVGElement (HS-8241 / §62 bug-class fix)', () => {
    // Pre-HS-8241 the local <template>.innerHTML path silently produced
    // an HTMLUnknownElement for SVG roots and they never painted.
    // Post-HS-8241 the kerf-routed implementation parses through
    // DOMParser('image/svg+xml') so SVG roots get the correct namespace.
    const el = toElement(new SafeHtml('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>'));
    expect(el.tagName.toLowerCase()).toBe('svg');
    expect(el.namespaceURI).toBe('http://www.w3.org/2000/svg');
    const circle = el.querySelector('circle');
    expect(circle).not.toBeNull();
    expect(circle!.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(circle!.getAttribute('r')).toBe('40');
  });

  it('SVG fragment without an <svg> wrapper (e.g. raw <path>) produces a properly-namespaced SVG element (HS-8241 / §62 bug-class fix)', () => {
    // Previously `<path .../>` through innerHTML became an
    // HTMLUnknownElement; kerf wraps it with an svg root + parses + unwraps
    // so the result has the SVG namespace.
    const el = toElement(new SafeHtml('<path d="M10 10L90 90" stroke="red"/>'));
    expect(el.tagName.toLowerCase()).toBe('path');
    expect(el.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(el.getAttribute('d')).toBe('M10 10L90 90');
  });
});
