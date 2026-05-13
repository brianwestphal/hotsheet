// @vitest-environment happy-dom
/**
 * §60 / HS-8235 — DOM-binding helpers. Each test asserts BOTH the
 * happy-path update behavior AND the disposer contract (idempotent,
 * stops further updates).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { signal } from './reactive.js';
import { bindAttr, bindList, bindListVirtualized, bindText } from './reactive-bind.js';

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

describe('bindListVirtualized (HS-8371)', () => {
  type Row = { id: number; label: string };

  function rows(n: number, prefix = 'r'): Row[] {
    return Array.from({ length: n }, (_, i) => ({ id: i + 1, label: `${prefix}-${String(i + 1)}` }));
  }

  function render(row: Row): { el: Element } {
    const el = document.createElement('div');
    el.className = 'row';
    el.dataset.id = String(row.id);
    el.textContent = row.label;
    return { el };
  }

  function buildScrollContainer(): { scrollContainer: HTMLElement; parent: HTMLElement } {
    const scrollContainer = document.createElement('div');
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 320, configurable: true });
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, writable: true, configurable: true });
    const parent = document.createElement('div');
    scrollContainer.appendChild(parent);
    document.body.appendChild(scrollContainer);
    return { scrollContainer, parent };
  }

  it('below threshold — delegates to plain bindList; no padding side effects', () => {
    const { parent } = buildScrollContainer();
    const items = signal<Row[]>(rows(20));
    const dispose = bindListVirtualized(parent, items, r => r.id, render, {
      rowHeight: 32,
      buffer: 10,
      threshold: 100,
    });
    expect(parent.children.length).toBe(20);
    // Delegate mode — wrapper returns the bindList disposer verbatim
    // and never mutates `parent.style.padding*`. (The above-threshold
    // path's reset-on-dispose only fires when virtualized mode mounted.)
    expect(parent.style.paddingTop).toBe('');
    expect(parent.style.paddingBottom).toBe('');
    dispose();
  });

  it('above threshold — mounts only the rows in the viewport + buffer; pads parent for off-window rows', () => {
    const { parent } = buildScrollContainer();
    // 320 px viewport / 32 px row = 10 visible rows. buffer = 10 above + 10 below = 20 buffer rows. So ~30 mounted at scrollTop=0.
    const items = signal<Row[]>(rows(500));
    const dispose = bindListVirtualized(parent, items, r => r.id, render, {
      rowHeight: 32,
      buffer: 10,
      threshold: 100,
    });
    const mountedCount = parent.querySelectorAll('.row').length;
    // 10 (viewport) + 10 (bottom buffer) = 20. The top buffer at scrollTop=0 clamps to 0 so it's 20 not 30.
    expect(mountedCount).toBeGreaterThan(15);
    expect(mountedCount).toBeLessThan(25);
    // Padding top is 0 at scrollTop=0; padding bottom accounts for the unmounted tail.
    expect(parent.style.paddingTop).toBe('0px');
    const expectedBottom = (500 - mountedCount) * 32;
    expect(parent.style.paddingBottom).toBe(`${String(expectedBottom)}px`);
    dispose();
  });

  it('mounts ids matching the viewport offset; rows 1-N are the first N row ids at scrollTop=0', () => {
    const { parent } = buildScrollContainer();
    const items = signal<Row[]>(rows(500));
    const dispose = bindListVirtualized(parent, items, r => r.id, render, {
      rowHeight: 32, buffer: 10, threshold: 100,
    });
    const firstId = parent.querySelector<HTMLElement>('.row')?.dataset.id;
    expect(firstId).toBe('1');
    dispose();
  });

  it('scroll event reshapes the window — mid-list scroll mounts mid-list rows, drops top + bottom', () => {
    const { scrollContainer, parent } = buildScrollContainer();
    const items = signal<Row[]>(rows(500));
    const dispose = bindListVirtualized(parent, items, r => r.id, render, {
      rowHeight: 32, buffer: 10, threshold: 100,
    });
    // Scroll to row 200's offset: 200 * 32 = 6400 px.
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 6400, writable: true, configurable: true });
    scrollContainer.dispatchEvent(new Event('scroll'));
    const ids = Array.from(parent.querySelectorAll<HTMLElement>('.row')).map(el => Number(el.dataset.id));
    // Window starts at array-index (200 - 10 buffer) = 190 → id at that
    // slot is `190 + 1 = 191` because the helper assigns `id = i + 1`.
    expect(ids[0]).toBe(191);
    // Window ends at array-index 220 → id at that slot is 221. Mounted
    // ids cover roughly [191, 221).
    expect(ids[ids.length - 1]).toBeLessThan(226);
    expect(ids[ids.length - 1]).toBeGreaterThan(216);
    // Row 1 is no longer in the DOM.
    expect(parent.querySelector('[data-id="1"]')).toBeNull();
    // Padding adjusts so the scrollHeight stays consistent.
    expect(parseInt(parent.style.paddingTop, 10)).toBe(190 * 32);
    dispose();
  });

  it('dispose() removes the scroll listener and resets padding', () => {
    const { scrollContainer, parent } = buildScrollContainer();
    const items = signal<Row[]>(rows(500));
    const dispose = bindListVirtualized(parent, items, r => r.id, render, {
      rowHeight: 32, buffer: 10, threshold: 100,
    });
    expect(parent.style.paddingBottom).not.toBe('');
    dispose();
    expect(parent.style.paddingTop).toBe('');
    expect(parent.style.paddingBottom).toBe('');
    // Subsequent scroll event should NOT mutate padding (listener gone).
    const before = parent.style.paddingTop;
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 5000, writable: true, configurable: true });
    scrollContainer.dispatchEvent(new Event('scroll'));
    expect(parent.style.paddingTop).toBe(before);
  });

  it('signal change shrinks the array — padding-bottom updates so the scrollbar reflects the new total', () => {
    const { parent } = buildScrollContainer();
    const items = signal<Row[]>(rows(500));
    const dispose = bindListVirtualized(parent, items, r => r.id, render, {
      rowHeight: 32, buffer: 10, threshold: 100,
    });
    const beforeMounted = parent.querySelectorAll('.row').length;
    const beforeBottom = parseInt(parent.style.paddingBottom, 10);
    items.value = rows(250);
    const afterBottom = parseInt(parent.style.paddingBottom, 10);
    expect(afterBottom).toBeLessThan(beforeBottom);
    // Mounted count stays roughly the same (we're still at scrollTop=0 so the
    // first ~20 rows are mounted regardless of total length).
    const afterMounted = parent.querySelectorAll('.row').length;
    expect(afterMounted).toBeGreaterThan(beforeMounted - 5);
    expect(afterMounted).toBeLessThan(beforeMounted + 5);
    dispose();
  });

  it('falls back to plain bindList when scrollContainer is null (parent has no scrollable ancestor)', () => {
    // Mount parent WITHOUT a scroll-container ancestor — bindListVirtualized's
    // default `parent.parentElement` is null, the wrapper short-circuits.
    const parent = document.createElement('div');
    const items = signal<Row[]>(rows(500));
    const dispose = bindListVirtualized(parent, items, r => r.id, render, {
      rowHeight: 32, threshold: 100,
    });
    // All 500 rows mount — delegate mode.
    expect(parent.children.length).toBe(500);
    expect(parent.style.paddingTop).toBe('');
    dispose();
  });
});
