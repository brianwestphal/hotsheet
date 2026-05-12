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
 * `mount` / `morph` / `each` / `toElement` / `SafeHtml` / `raw` / `Fragment`
 * (HS-8241+ / §62). One dependency covers all three design-doc chains.
 * §63 (the parallel `morphdom`-based reactivity-demo plan) was retired
 * under HS-8315 in favour of kerf — see the §63 cleanup note in
 * `docs/60-reactivity-primitive.md` §60.3.
 *
 * HS-8364 — bumped kerfjs `^0.5.1` → `^0.6.0`. 0.6.0 adds the public
 * `morph(liveRoot, template)` export (one-shot in-place reconciliation
 * primitive — same algorithm `mount()` uses internally, exported for
 * consumers that have an already-populated element they need to
 * reconcile against a freshly-built template; focus / selection /
 * uncontrolled-details / `data-morph-skip` semantics all carry over) plus
 * two new opt-out attributes for consumers using `mount` / `morph`:
 * `data-morph-preserve` (an unmatched live element survives the trailing-
 * removal pass — for imperatively-injected nodes) and
 * `data-morph-skip-children` (morph attrs on the host but leave its
 * subtree intact — for client-hydrated slots). None of those changes
 * affect the four-primitive + store surface this module re-exports today;
 * `morph` is added to the re-export list (HS-8365) so the first wave of
 * consumers landed in `readerOverlay.tsx` + `feedbackDialog.tsx`.
 */
export type { ReadonlySignal, Signal, Store } from 'kerfjs';
export { batch, computed, defineStore, effect, morph, resetAllStores, signal } from 'kerfjs';
