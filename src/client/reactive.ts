/**
 * §60 / HS-8235 — fine-grained reactivity primitive.
 * §61 / HS-8238 — `defineStore` / `resetAllStores` / `Store` re-exports.
 *
 * Re-exports the kerfjs surface area Hot Sheet depends on. The
 * indirection is deliberate per docs/60-reactivity-primitive.md §60.4:
 * callers depend on `'./reactive.js'` instead of mentioning the
 * underlying lib so we can swap the implementation without touching
 * consumers.
 *
 * Library choice: `kerfjs` (sister project at `~/Documents/kerf`,
 * published as `kerfjs` on npm; written by the same author as Hot Sheet).
 * It wraps the underlying signals primitive verbatim for the four primitive
 * functions, AND ships `defineStore` / `resetAllStores` (HS-8238 / §61) PLUS
 * `mount` / `each` / `toElement` / `SafeHtml` / `raw` / `Fragment`
 * (HS-8241+ / §62). One dependency covers all three design-doc chains.
 * §63 (the parallel `morphdom`-based reactivity-demo plan) was retired
 * under HS-8315 in favour of kerf — see the §63 cleanup note in
 * `docs/60-reactivity-primitive.md` §60.3.
 */
export type { ReadonlySignal, Signal, Store } from 'kerfjs';
export { batch, computed, defineStore, effect, resetAllStores, signal } from 'kerfjs';
