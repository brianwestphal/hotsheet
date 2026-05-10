# 60. Fine-grained reactivity primitive (Design Spike)

HS-8166. Follow-up to the HS-8165 investigation ("would Solid be a better option than our custom JSX runtime?"). HS-8165's verdict was "don't migrate to Solid; the pain is manual rebuilds and ad-hoc state, not the JSX runtime." This document is the design for the reactivity half of that fix.

> **Status:** Phase 1 (HS-8235) shipped 2026-05-09. Phases 2 (HS-8236) + 3 (HS-8237) still queued. See §60.5 for what landed.
> **Verdict:** Adopt `kerfjs` (sister project; re-exports `@preact/signals-core` for the four primitives PLUS ships `defineStore` / `resetAllStores` / `mount` / `each` — covers §60 + §61 + §62 deliverables in one dependency) behind a thin re-export module, ship three keyed-binding helpers, migrate one trial callsite, then expand opportunistically. Keeps `src/jsx-runtime.ts` and `toElement(<jsx />)` unchanged in Phase 1.

## 60.1 Problem statement

Today every "rebuild this view when X changes" in `src/client/` is hand-wired. A grep gives the rough shape:

- ~59 client `.tsx` files use JSX.
- ~54 callsites do `el.innerHTML =` / `parent.replaceChildren(...)` / manual rebuild loops.
- `subscribeTo*` plumbing is duplicated per-feature (project tabs, ticket list, command log, terminal tabs, drawer-grid tiles, dashboard tiles, channel state, …).

When a piece of state changes, every consumer that displays it has to know to refresh. Adding a new field that affects multiple views means hunting every consumer; missing one leaves a piece of UI silently out of date until a coarser refresh fires (often `notifyChange()` poll-version bump or a project switch). HS-8165's investigation called this out as the most painful pattern in the current code, distinct from anything the JSX runtime itself does or doesn't do.

We do not want a framework swap (HS-8165 settled that). We want fine-grained automatic re-render for the cases where it matters, layered on top of the existing JSX + `toElement` flow.

## 60.2 Why a signals primitive (and nothing more)

A reactive value (`signal`) auto-notifies subscribers when it changes. A reactive view function (`effect` / `computed`) auto-re-runs when any signal it reads changes. That is the entire mental model. There is **no** virtual DOM, **no** template compiler, **no** component lifecycle, **no** SSR rewrite.

Everything we already have keeps working:

- `jsx-runtime.ts` still produces `SafeHtml`. Server-rendered pages are unchanged.
- `toElement(<jsx />)` still parses to DOM via `innerHTML`. No churn for the 99% of callsites that mount once and stay.
- The defensive "JSX: DOM elements cannot be passed as children" throw (HS-6341 / HS-6342) stays.
- `raw(html)` for pre-rendered SVG icons is unaffected.

The signals primitive only takes over the WHEN-to-re-mount question for the views that opt in.

## 60.3 Library choice — `kerfjs` (wraps `@preact/signals-core`)

**Updated 2026-05-09 during HS-8235 implementation.** The original survey
recommended `@preact/signals-core` direct. While shipping HS-8235 we
re-evaluated and landed on `kerfjs` (sister project at
`~/Documents/kerf`, published as `kerfjs` on npm — initially pinned at
`^0.3.1`, bumped to `^0.5.0` under HS-8316 on 2026-05-10) instead. `kerfjs` re-exports
`@preact/signals-core` verbatim for the four primitive functions, AND
ships `defineStore` / `resetAllStores` (the §61 deliverable) PLUS
`mount` / `each` / `toElement` / `SafeHtml` / `raw` / `Fragment`
(relevant for §62). Adopting one dependency unblocks all three
design-doc chains and avoids three rounds of "build a thin wrapper, then
realise we want the same thing kerfjs already shipped." The Hot Sheet
`src/client/reactive.ts` re-export still mediates so callsites depend on
`'./reactive.js'` and the underlying lib remains swappable. Original
survey kept below for context.

Surveyed three:

### Option A — `@preact/signals-core` ✅ recommended

- ~1.4 KB minified + gzipped. Pure reactivity primitive, zero UI layer, zero ecosystem assumptions.
- Stable, widely deployed, well-tested. Solid's signals primitive is older but Preact's lifts the design lessons and ships standalone.
- API: `signal(initial)`, `computed(fn)`, `effect(fn) → dispose`, `batch(fn)`. That is everything we need.

### Option B — `solid-js`'s `createSignal` / `createEffect` re-exported standalone

- Solid's runtime is reactive without the JSX compiler — you can `import { createSignal, createEffect } from 'solid-js'` and use it as a primitive.
- ~7 KB. Not bad, but 5× the size of Option A for no functional win at the primitive level.
- Pulls in transitively more code that we'd have to tree-shake against.

### Option C — Hand-rolled signals

- 50 lines of TypeScript covers `signal` + `effect`. Plenty of blog posts walk through it.
- Cons: edge cases (cycle detection, batch semantics, computed-of-computed dependency tracking) are exactly the kind of work where a vetted lib pays for itself.
- The few KB Option A costs us is not worth re-implementing this.

**Decision: Option A.** Hidden behind a one-file re-export so we can swap to Option B or hand-rolled later without touching consumers.

## 60.4 Module surface

Two new client files. No server changes.

### `src/client/reactive.ts`

Re-exports `signal`, `computed`, `effect`, `batch` from `@preact/signals-core`. That's it. Lets the rest of the codebase depend on `'./reactive.js'` without mentioning Preact, so the underlying library is swappable.

### `src/client/reactive-bind.ts`

Three DOM-binding helpers. Every helper returns a `() => void` disposer the caller is responsible for invoking when the bound element leaves the DOM.

#### `bindText(el, signal): () => void`

Sets `el.textContent` whenever `signal.value` changes. For badge counts, ticket numbers, status labels, the `Last fetched N minutes ago` row in the git popover, etc.

#### `bindAttr(el, attr, signal): () => void`

Same shape for `setAttribute` / `removeAttribute` (boolean false → remove, otherwise stringify). For toggling `disabled` / `aria-busy` / `data-state` / `hidden` on signal change. Works against any `Element`.

#### `bindList(parent, signal<T[]>, key, render): () => void`

The big-impact helper — keyed list reconciliation. Replaces every `parent.replaceChildren(...rows.map(toElement))` rebuild.

- Items keep DOM identity across updates. New items get rendered via `render(item) → HTMLElement`, removed items get their `dispose()` called and are detached, order changes shuffle existing nodes.
- Key extraction is mandatory — `key(item) → string | number`. No "use object identity" mode; that's the road to bug-by-coincidence.
- Each row owns its own effects (its render function may set up further `bindText` / `bindAttr` against per-item signals); the row's disposer composes them. When a row is removed, every effect bound to it is torn down before the node detaches.

### What's NOT in the helper module

- `bindClass` — falls out of `bindAttr(el, 'class', sig)`. Add later if a real consumer wants atomic class toggling.
- `bindStyle` — same.
- `if` / `else` / `show` / `hide` helpers — DOM mounting/unmounting decisions are per-feature; not worth a generic helper until we see two callsites.
- Reactive context / scope / cleanup-tree machinery — Solid has it; we don't need it for the migrations we want to do. If a future migration demands it, we can add a small `reactiveScope()` wrapper without breaking existing helpers.

## 60.5 Migration plan

Incremental. Every existing manual rebuild keeps working until its callsite is migrated.

### Phase 1 — primitive in place + one trial migration (HS-8235) — **shipped 2026-05-09**

- ✅ `src/client/reactive.ts` re-exports `signal` / `computed` / `effect` / `batch` from `kerfjs`.
- ✅ `src/client/reactive-bind.ts` ships `bindText` / `bindAttr` / `bindList`. Each returns a `() => void` disposer; `bindList` owns its rows' per-row disposers (caller doesn't manage row lifetimes).
- ✅ Unit tests: `src/client/reactive.test.ts` (4 cases — primitive smoke) + `src/client/reactive-bind.test.ts` (16 cases — every helper, every disposer-contract bullet from §60.9).
- ✅ Trial migration: `src/client/projectTabs.tsx`. `projectList` became `projectListSignal: Signal<readonly ProjectInfo[]>`; `activeSecretSignal: Signal<string | null>` mirrors `getActiveProject()?.secret` via a local `setActive()` wrapper around `setActiveProject`. Multi-tab path now mounts a `bindList` against the signal exactly once per single↔multi transition; per-row `effect()` flips the `.active` class without re-mounting the row. Single-project (h1) path stays imperative. Pre-fix `lastRenderedTabsFingerprint` short-circuit removed (the `bindList` keyed reconcile subsumes it). 7 integration tests in `src/client/projectTabs.test.ts` cover initial render / add / remove / reorder / active-flip-without-remount / multi↔single transitions.
- ✅ ESLint rule: `no-restricted-syntax` selector `ExpressionStatement > CallExpression[callee.name=/^bind(Text|Attr|List)$/]` flags discarded disposers (the §60.6 footgun). `void bindText(...)` is the documented escape hatch for the rare deliberately-leaked case.
- ⏭️ Bundle-size CI gate: skipped per user direction during HS-8235. Can be added later if a transitive bloat regression surfaces.

### Phase 2 — high-traffic surfaces (HS-8236)

After Phase 1 ships and the helper API has had a chance to settle:

- Ticket list (`src/client/ticketList.tsx`).
- Command log (`src/client/commandLog.tsx`).
- Terminal tabs / tile grid (`src/client/terminal.tsx`, `src/client/terminalTileGrid.tsx`, `src/client/drawerTerminalGrid.tsx`).

Each one is its own sub-ticket so the work can land in pieces and be reverted individually if the migration introduces a regression.

### Phase 3 — long tail (HS-8237)

Convert remaining manual-rebuild callsites opportunistically. **Not a hard requirement** to convert all 54 — some are mounted once and never rebuild, in which case a signal is overkill. The win is on the high-frequency rebuild paths; the low-frequency ones can stay imperative without anyone noticing.

**Closed as effectively-discharged 2026-05-10.** Post-Phase-2 survey: every callsite that meets the high-frequency rebuild bar has already been migrated under a Phase 2 sub-ticket (project tabs HS-8235; drawer terminal tabs HS-8312; tile grid HS-8313 + drawer-grid HS-8314) or is owned by a queued ticket (ticket list HS-8239; command log + projects/terminals/channel stores HS-8240). The remaining ~50 `replaceChildren` / `innerHTML = ''` callsites are all low-frequency dialog / settings / mode-switch surfaces (settings categories, backups list, feedbackDialog file list, tagsDialog rows, dashboardMode swap, plugin settings, etc.) — exactly the carve-out this section calls out as "can stay imperative." Future opportunistic conversions, when triggered by an actual manual-rebuild bug or natural integration with other work, get filed as fresh tickets.

## 60.6 Memory-leak hardening

`effect()` callbacks that aren't disposed when their owning DOM tree is removed leak — every signal write keeps re-running the effect against an orphaned element. This is the most common signals-primitive footgun and needs explicit attention before broad rollout.

Three layers of defence:

1. **`bindList` owns its rows' disposers.** When a row is removed (key drops out of the signal's value array), the row's effect tree is torn down before the node detaches. Callers don't manage row lifetimes.
2. **`bindText` / `bindAttr` return a disposer.** Caller is responsible for invoking it when the bound element leaves the DOM. Most callsites that opt in already manage their own teardown (`termHandlerDisposers`, `releaseHandle`, etc.) — adding the disposer to the existing list is a one-liner.
3. **Lint-level safety net.** Add an ESLint rule (or simple `eslint-plugin-local`) that flags `bindText(...)` / `bindAttr(...)` calls whose return value is discarded. Phase 1 lands the rule alongside the helpers.

`MutationObserver`-based auto-disposal-on-detach was considered and rejected: silent magic, hides leaks rather than preventing them, and observers don't fire for elements removed via `innerHTML = ''` clobber. Explicit disposal is more verbose but always correct.

## 60.7 Open questions / deferred decisions

- **`bindList` reorder strategy** — naive "remove + re-insert in new order" is correct but causes layout thrash on long lists. A smarter "longest common subsequence" reorder is a half-day's work and can drop in later without changing the helper signature. Defer until a real consumer has a list long enough to feel the thrash.
- **Server-side signals** — out of scope. Server `pages.tsx` stays a one-shot render. If we ever ship a streaming-server-render path, signals don't help anyway (different problem).
- **Reactivity-aware test harness** — for now, tests that exercise `bindList` will use happy-dom and assert DOM state directly. If a test pattern emerges where we want to "wait for reactive flush", revisit then; `effect()` is synchronous in the chosen lib so most tests won't need it.
- **Stores** — see [§61](61-composable-stores.md). Stores are the convention layered on top of signals; this doc is just the primitive.
- **Unified render targets** — see [§62](62-unified-jsx-render-targets.md). Independent of this doc; signals don't change anything about how `toElement` parses HTML.

## 60.8 What stays the same

- `jsx-runtime.ts` — unchanged. JSX still compiles to `SafeHtml`.
- `toElement(<jsx />)` — unchanged. Signals decide WHEN to re-mount, not HOW.
- Server-rendered initial paint via `pages.tsx` — unchanged. Signals are client-only.
- The defensive 'JSX: DOM elements cannot be passed as children' throw — unchanged.
- All existing JSX call sites — unchanged. New helpers are additive.
- Bundle size baseline — Phase 1 measures the delta; expectation is +1.4 KB min+gz for the primitive plus a few hundred bytes for the binding helpers.

## 60.9 Tests

- Unit tests for each helper using a happy-dom env (`src/client/reactive.test.ts`, `src/client/reactive-bind.test.ts`).
  - `bindText` updates DOM on signal change; disposer stops further updates.
  - `bindAttr` toggles attributes; boolean-false removes the attribute entirely; disposer is idempotent.
  - `bindList` reconciles add / remove / reorder by key; per-row disposers fire on removal; mounting + unmounting the parent disposes the whole subtree.
- Integration test for the trial Phase 1 migration: project tabs render correctly when projects change, including reorder and add-while-active-project paths.
- Bundle-size regression: a Phase 1 CI step that diffs `dist/client/app.js` size and fails if the delta exceeds a budget (e.g. +5 KB). Helps catch transitive bloat from the primitive — even though `@preact/signals-core` is small, future swaps shouldn't silently regress.

## 60.10 Open-source angle

`reactive-bind.ts` + the existing `jsx-runtime.ts` together form a complete "minimal reactive JSX over plain DOM" pattern that's interesting on its own — no framework, no compiler step beyond standard JSX, ~3 KB total runtime including the signals lib. Could be carved out as a tiny standalone package once the patterns prove out across the three migration phases. Not blocking; just worth keeping the boundary clean from day one.

## 60.11 Cost estimate

- Phase 1 (HS-8235): ~half a day. Library + helpers + tests + one trial migration + bundle measurement.
- Phase 2 (HS-8236): ~1–2 days per major list view including tests. Spread across sub-tickets.
- Phase 3 (HS-8237): opportunistic; not budgeted up-front.

## 60.12 Risks

- Memory leaks — see §60.6. Real risk; mitigated by helper-owned disposal + lint rule + per-callsite review during migration.
- Subtle reactivity bugs (read in the wrong order, batch semantics, computed-of-computed missed updates). Mitigated by keeping each migrated callsite small, reviewing in isolation, and the unit-test corpus on the helpers themselves.
- Library swap risk — `@preact/signals-core` is stable, but if Preact ever stops shipping it we want a clean swap path. The `reactive.ts` re-export is the only file that has to change.
- Over-reach — converting low-frequency rebuild callsites to signals adds machinery for no benefit. Mitigation: Phase 3 is explicitly opportunistic, not exhaustive.

## 60.13 Status & follow-up tickets

- **HS-8166 — this design.** Status: design only; closes once the doc lands.
- **HS-8235 — Phase 1: primitive + helpers + trial migration.** Project tabs the proposed trial. Includes lint rule, bundle measurement, equivalence tests.
- **HS-8236 — Phase 2: high-traffic surfaces.** Will be split into per-surface sub-tickets when picked up (ticket list, command log, terminals).
- **HS-8237 — Phase 3: long-tail conversions.** Closed 2026-05-10 as effectively-discharged — every high-frequency rebuild surface was covered under Phase 2 sub-tickets (HS-8235 project tabs; HS-8312 drawer terminal tabs; HS-8313 tile grid; HS-8314 drawer-grid) or remains owned by HS-8239 (ticket list) / HS-8240 (command log + projects / terminals / channel stores). Remaining `replaceChildren` / `innerHTML = ''` callsites are the low-frequency dialog / settings / mode-switch surfaces this section explicitly carved out. New tickets get filed if a manual-rebuild bug surfaces or natural integration with other work makes a conversion cheap.

## 60.14 Cross-refs

- [§61. Composable testable stores](61-composable-stores.md) — convention layer on top of this primitive. Depends on HS-8166 landing first.
- [§62. Unified JSX render targets](62-unified-jsx-render-targets.md) — independent track addressing the *server `SafeHtml` vs client `toElement`* divergence. No dependency either direction.
- HS-8165 — investigation that produced the verdict driving this doc.
- §1 (overview) — local-first developer focus + lightweight client.
- §17 of `docs/ai/code-summary.md` — client bundle entry; bundle-size regression check lives there.
