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
 *
 * HS-8444 — bumped kerfjs `^0.6.0` → `^0.8.0` (2026-05-18). 0.7.0
 * brought a fistful of additive changes: in-place granular list updates
 * now preserve focus / scroll / IME state / `<details open>` /
 * `<dialog open>` / `data-morph-skip` subtrees through `each()` row
 * updates; lowercase HTML attribute names (`class`, `for`, `tabindex`,
 * `autofocus`, `autocomplete`, `spellcheck`) are now first-class in
 * the JSX types; two new opt-in dev warnings (`KERF_DEV_WARN_REBUILT_LISTENERS`,
 * `KERF_DEV_WARN_UNTRACKED_SIGNALS`); `defineStore`'s `get()` snapshot
 * is now frozen in dev so accidental mutation throws a `TypeError`
 * rather than silently desyncing reactive consumers; `mount()` throws
 * when called on an element already inside a mounted tree (we don't
 * call `mount()` directly — every UI surface goes through
 * `toElement` + manual signals, so this guard is a no-op for us);
 * clearer JSX runtime error pointing at `delegate()` for
 * `onClick={fn}`-style attributes (always was an error, message is
 * better). 0.8.0 adds an opt-in `KERF_DEV_WARN_NARROW_SET` dev warning
 * + widens `contentEditable` to accept `'plaintext-only'` + a lowercase
 * `contenteditable` alias. We audited every `get()` call across the
 * defineStore consumers (`commandLogStore` / `commandLogSelectionStore`
 * / `projectsStore` / `channelStore` / `visibilityGroupingsStore` + the
 * `channelUI` attention-dot trial) — every `get()` is either read-only
 * or spread into a fresh object, no mutation antipattern, so the new
 * frozen-snapshot semantics surface no regressions. All 3099 unit
 * tests + tsc + lint + build pass after the bump.
 */
export type { ReadonlySignal, Signal, Store } from 'kerfjs';
export { batch, computed, defineStore, effect, morph, resetAllStores, signal } from 'kerfjs';
