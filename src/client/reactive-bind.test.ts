// @vitest-environment happy-dom
/**
 * §60 / HS-8235 — DOM-binding helpers. Each test asserts BOTH the
 * happy-path update behavior AND the disposer contract (idempotent,
 * stops further updates).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { signal } from './reactive.js';
import { bindAttr, bindList, bindText } from './reactive-bind.js';

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  document.body.removeChild(host);
});

describe('bindText (HS-8235)', () => {
  it('writes initial value and updates on signal change', () => {
    const s = signal('first');
    const dispose = bindText(host, s);
    expect(host.textContent).toBe('first');
    s.value = 'second';
    expect(host.textContent).toBe('second');
    dispose();
  });

  it('disposer stops further updates', () => {
    const s = signal('alpha');
    const dispose = bindText(host, s);
    dispose();
    s.value = 'beta';
    expect(host.textContent).toBe('alpha');
  });

  it('disposer is idempotent', () => {
    const s = signal('one');
    const dispose = bindText(host, s);
    dispose();
    expect(() => dispose()).not.toThrow();
  });

  it('null and undefined render as empty string (not literal "null")', () => {
    const s = signal<string | null | undefined>('value');
    const dispose = bindText(host, s);
    expect(host.textContent).toBe('value');
    s.value = null;
    expect(host.textContent).toBe('');
    s.value = undefined;
    expect(host.textContent).toBe('');
    dispose();
  });

  it('numeric values stringify', () => {
    const s = signal<number>(42);
    const dispose = bindText(host, s);
    expect(host.textContent).toBe('42');
    s.value = 0;
    expect(host.textContent).toBe('0');
    dispose();
  });
});

describe('bindAttr (HS-8235)', () => {
  it('sets attribute on initial value and updates on signal change', () => {
    const s = signal('busy');
    const dispose = bindAttr(host, 'aria-busy', s);
    expect(host.getAttribute('aria-busy')).toBe('busy');
    s.value = 'idle';
    expect(host.getAttribute('aria-busy')).toBe('idle');
    dispose();
  });

  it('boolean true sets attribute with empty value (HTML normal-form)', () => {
    const s = signal<boolean>(false);
    const dispose = bindAttr(host, 'disabled', s);
    expect(host.hasAttribute('disabled')).toBe(false);
    s.value = true;
    expect(host.hasAttribute('disabled')).toBe(true);
    expect(host.getAttribute('disabled')).toBe('');
    dispose();
  });

  it('boolean false removes attribute entirely', () => {
    host.setAttribute('disabled', '');
    const s = signal<boolean>(false);
    const dispose = bindAttr(host, 'disabled', s);
    expect(host.hasAttribute('disabled')).toBe(false);
    dispose();
  });

  it('null and undefined remove attribute entirely', () => {
    host.setAttribute('data-x', 'present');
    const s = signal<string | null | undefined>(null);
    const dispose = bindAttr(host, 'data-x', s);
    expect(host.hasAttribute('data-x')).toBe(false);
    s.value = 'v';
    expect(host.getAttribute('data-x')).toBe('v');
    s.value = undefined;
    expect(host.hasAttribute('data-x')).toBe(false);
    dispose();
  });

  it('disposer is idempotent', () => {
    const s = signal('x');
    const dispose = bindAttr(host, 'data-y', s);
    dispose();
    expect(() => dispose()).not.toThrow();
  });
});

describe('bindList (HS-8235)', () => {
  interface Row { id: number; label: string }

  function renderRow(item: Row): { el: Element; dispose?: () => void } {
    const el = document.createElement('div');
    el.dataset.key = String(item.id);
    el.textContent = item.label;
    return { el };
  }

  it('initial render mounts every row in the source order', () => {
    const items = signal<Row[]>([
      { id: 1, label: 'one' },
      { id: 2, label: 'two' },
      { id: 3, label: 'three' },
    ]);
    const dispose = bindList(host, items, (r) => r.id, renderRow);
    expect(Array.from(host.children).map((c) => (c as HTMLElement).dataset.key)).toEqual(['1', '2', '3']);
    expect(Array.from(host.children).map((c) => c.textContent)).toEqual(['one', 'two', 'three']);
    dispose();
  });

  it('appended item adds a new node without rebuilding existing ones', () => {
    const items = signal<Row[]>([{ id: 1, label: 'one' }]);
    const dispose = bindList(host, items, (r) => r.id, renderRow);
    const firstNode = host.firstElementChild;
    items.value = [{ id: 1, label: 'one' }, { id: 2, label: 'two' }];
    expect(host.firstElementChild).toBe(firstNode);
    expect(host.children.length).toBe(2);
    dispose();
  });

  it('removed item detaches node and calls per-row disposer', () => {
    const disposed: number[] = [];
    function renderWithDispose(item: Row): { el: Element; dispose?: () => void } {
      const el = document.createElement('div');
      el.dataset.key = String(item.id);
      el.textContent = item.label;
      return { el, dispose: () => disposed.push(item.id) };
    }
    const items = signal<Row[]>([
      { id: 1, label: 'one' },
      { id: 2, label: 'two' },
    ]);
    const dispose = bindList(host, items, (r) => r.id, renderWithDispose);
    items.value = [{ id: 1, label: 'one' }];
    expect(host.children.length).toBe(1);
    expect((host.firstElementChild as HTMLElement).dataset.key).toBe('1');
    expect(disposed).toEqual([2]);
    dispose();
  });

  it('reorders existing nodes via insertBefore (preserves DOM identity)', () => {
    const items = signal<Row[]>([
      { id: 1, label: 'one' },
      { id: 2, label: 'two' },
      { id: 3, label: 'three' },
    ]);
    const dispose = bindList(host, items, (r) => r.id, renderRow);
    const node2 = host.children[1];
    const node3 = host.children[2];
    items.value = [
      { id: 3, label: 'three' },
      { id: 1, label: 'one' },
      { id: 2, label: 'two' },
    ];
    expect(host.children[0]).toBe(node3);
    expect(host.children[2]).toBe(node2);
    expect(Array.from(host.children).map((c) => (c as HTMLElement).dataset.key)).toEqual(['3', '1', '2']);
    dispose();
  });

  it('outer disposer fires every per-row dispose AND stops further updates', () => {
    const disposed: number[] = [];
    function renderWithDispose(item: Row): { el: Element; dispose?: () => void } {
      const el = document.createElement('div');
      el.dataset.key = String(item.id);
      return { el, dispose: () => disposed.push(item.id) };
    }
    const items = signal<Row[]>([
      { id: 1, label: 'one' },
      { id: 2, label: 'two' },
    ]);
    const dispose = bindList(host, items, (r) => r.id, renderWithDispose);
    dispose();
    expect(disposed.sort()).toEqual([1, 2]);
    // Subsequent signal write does NOT re-fire the effect.
    const childCountBefore = host.children.length;
    items.value = [{ id: 99, label: 'x' }];
    expect(host.children.length).toBe(childCountBefore);
  });

  it('per-row disposer fires for replaced rows even if a new row reuses the same key later', () => {
    const events: string[] = [];
    function renderWithDispose(item: Row): { el: Element; dispose?: () => void } {
      const el = document.createElement('div');
      el.dataset.key = String(item.id);
      el.textContent = item.label;
      events.push(`mount:${item.id}:${item.label}`);
      return { el, dispose: () => events.push(`dispose:${item.id}`) };
    }
    const items = signal<Row[]>([{ id: 1, label: 'first' }]);
    const dispose = bindList(host, items, (r) => r.id, renderWithDispose);
    items.value = [];
    items.value = [{ id: 1, label: 'reborn' }];
    expect(events).toEqual(['mount:1:first', 'dispose:1', 'mount:1:reborn']);
    expect(host.firstElementChild?.textContent).toBe('reborn');
    dispose();
  });
});
