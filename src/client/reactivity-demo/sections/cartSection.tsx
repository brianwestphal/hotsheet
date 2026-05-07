/**
 * Section 2 — Cart store with multi-consumer + reset hook.
 *
 * Three independent regions on the page (a count badge in the header, a list
 * of items, a total-price footer) all subscribe to the same store via
 * separate `morphBind()` calls. Adding / removing items updates all three
 * with no manual wiring. The `reset` button calls `resetAllStores()` which
 * walks the global registry — this section's store is registered automatically
 * by `defineStore()`.
 */

import { delegate } from '../../reactivity/delegate.js';
import { morphBind } from '../../reactivity/morphBind.js';
import { computed } from '../../reactivity/reactive.js';
import { defineStore, resetAllStores } from '../../reactivity/store.js';

interface CartItem {
  id: string;
  name: string;
  price: number;
}

interface CartState {
  items: CartItem[];
}

let nextId = 1;
function makeId(): string { return `item-${nextId++}`; }

const cartStore = defineStore<CartState, {
  add(name: string, price: number): void;
  remove(id: string): void;
  clear(): void;
}>({
  initial: () => ({ items: [] }),
  actions: (set, get) => ({
    add(name, price) {
      set({ items: [...get().items, { id: makeId(), name, price }] });
    },
    remove(id) {
      set({ items: get().items.filter((item) => item.id !== id) });
    },
    clear() {
      set({ items: [] });
    },
  }),
});

const SAMPLES: Array<[string, number]> = [
  ['Coffee', 4.5],
  ['Croissant', 3.25],
  ['Notebook', 12],
  ['Pen', 2.75],
];

export function mountCart(root: HTMLElement): void {
  // Top-level scaffold — never re-renders, just hosts the three subscribed regions.
  root.innerHTML = '';
  root.appendChild(createScaffold());

  const badgeEl = root.querySelector<HTMLElement>('[data-region="badge"]')!;
  const listEl = root.querySelector<HTMLElement>('[data-region="list"]')!;
  const footerEl = root.querySelector<HTMLElement>('[data-region="footer"]')!;

  const total = computed(() =>
    cartStore.state.value.items.reduce((sum, item) => sum + item.price, 0),
  );

  // Three independent subscribers to the same store.
  morphBind(badgeEl, () => (
    <span className="demo-badge">{cartStore.state.value.items.length}</span>
  ));

  morphBind(listEl, () => {
    const items = cartStore.state.value.items;
    if (items.length === 0) {
      return (
        <ul className="demo-cart-list">
          <li className="demo-cart-empty">Cart is empty — add something below.</li>
        </ul>
      );
    }
    return (
      <ul className="demo-cart-list">
        {items.map((item) => (
          <li className="demo-cart-row" data-key={item.id}>
            <span className="demo-cart-name">{item.name}</span>
            <span className="demo-cart-price">${item.price.toFixed(2)}</span>
            <button type="button" data-action="remove" data-id={item.id} className="demo-btn demo-btn-ghost demo-btn-tiny">×</button>
          </li>
        ))}
      </ul>
    );
  });

  morphBind(footerEl, () => (
    <div className="demo-cart-total">
      <span>Total</span>
      <strong>${total.value.toFixed(2)}</strong>
    </div>
  ));

  // Tier 1 click delegation — handles all three add buttons + remove buttons + clear.
  delegate(root, 'click', '[data-action="add"]', (_e, btn) => {
    const idx = Number((btn as HTMLElement).dataset.idx);
    const sample = SAMPLES[idx];
    cartStore.actions.add(sample[0], sample[1]);
  });
  delegate(root, 'click', '[data-action="remove"]', (_e, btn) => {
    const id = (btn as HTMLElement).dataset.id;
    if (id !== undefined) cartStore.actions.remove(id);
  });
  delegate(root, 'click', '[data-action="clear"]', () => { cartStore.actions.clear(); });
  delegate(root, 'click', '[data-action="reset-all"]', () => { resetAllStores(); });
}

function createScaffold(): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'demo-card';
  wrapper.innerHTML = `
    <h2>
      2. Cart store
      <span class="demo-tag">defineStore • multi-consumer • resetAllStores()</span>
      <span class="demo-cart-badge-slot" data-region="badge"></span>
    </h2>

    <div class="demo-row demo-cart-add-row">
      ${SAMPLES.map((s, i) => `<button type="button" data-action="add" data-idx="${i}" class="demo-btn">+ ${s[0]} ($${s[1].toFixed(2)})</button>`).join('')}
      <button type="button" data-action="clear" class="demo-btn demo-btn-ghost">clear</button>
      <button type="button" data-action="reset-all" class="demo-btn demo-btn-warn">resetAllStores()</button>
    </div>

    <div data-region="list"></div>
    <div data-region="footer"></div>

    <p class="demo-note">
      Three independent regions (badge, list, footer) subscribe via separate
      <code>morphBind()</code> calls. The footer's total is a <code>computed()</code>
      derived from the same store. <code>resetAllStores()</code> walks the registry —
      every store created via <code>defineStore()</code> is reset, including ones
      from other sections on this page.
    </p>
  `;
  return wrapper;
}
