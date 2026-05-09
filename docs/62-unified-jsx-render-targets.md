# 62. Unified JSX render targets via shared AST (Design Spike)

HS-8168. Follow-up to the HS-8165 investigation. Independent of [§60](60-reactivity-primitive.md) and [§61](61-composable-stores.md) — addresses a different class of bug (server vs client render-target divergence) and ships on its own track.

> **Status:** Re-scoped under HS-8315 (2026-05-09). Phase 1 (HS-8241) shipped 2026-05-09 via a much simpler path than the original plan; Phase 2 (HS-8242) merged into Phase 1; Phase 3 (HS-8243) shipped 2026-05-10 in its reduced rule-only-with-allowlist form.
> **Verdict (updated 2026-05-09):** Original plan was **Option B — build a `JsxNode` AST + `astToHtml` / `astToDom` consumers + 50-case equivalence corpus** (~1.5–2 days). Post-kerf-adoption (HS-8315) the much simpler path is to route Hot Sheet's `toElement` through `kerfjs::toElement`, which already implements the SVG-namespace fix the original plan cared about (same `SVG_FRAGMENT_TAGS` set, same `DOMParser('image/svg+xml')` for SVG fragments, same `<template>.innerHTML` fallback for HTML — byte-for-byte equivalent for HTML JSX). The §62 bug class is closed by the kerf swap; the dual-consumer AST is no longer needed.

## 62.1 Problem statement

Today there are two render targets walking different code paths from the same JSX:

- **Server** — `pages.tsx` + `components/layout.tsx` produce `SafeHtml` strings via `jsx-runtime.ts` and write them to the HTTP response.
- **Client** — `src/client/dom.ts::toElement(jsx)` does `el.innerHTML = jsx.toString()` then returns `el.firstChild` (a real DOM node), and call sites grab refs via `querySelector`.

Most of the time these produce equivalent output. A handful of edge cases do NOT round-trip cleanly through `innerHTML`:

### SVG namespacing

`<svg>` and its descendants need the `http://www.w3.org/2000/svg` namespace to render. Setting `innerHTML` on a `<div>` doesn't apply the SVG namespace to inner elements; `<path>` elements end up as un-rendered `HTMLUnknownElement` in many engines. `toElement` mostly side-steps this by always wrapping the root in the JSX (so the root `<svg>` triggers the parser's SVG-mode), but ad-hoc inner `<g>` insertions or `<svg>`-less SVG fragments fail silently.

### HTML entities + special chars in attributes

When an attribute value contains `&` / quotes the server-side `escapeAttr` produces clean HTML, but any consumer that reads the value back via `getAttribute` and re-renders gets a double-escape if they don't decode first. The bug class is "value looks fine when printed, breaks when fed back through the pipeline."

### Custom-element / template / namespaced attributes

`is`, `slot`, `xlink:href`, etc. Have ad-hoc handling in `ATTR_ALIASES`; the server-render path emits them correctly but `innerHTML` parsing on the client doesn't always preserve them depending on context (notably `<table>` / `<select>` parser quirks).

### Whitespace

`textContent` after parsing loses some whitespace shapes that the string version preserved. Rare but caused at least one bug historically.

### The shared symptom

It works 99% of the time, breaks subtly the other 1%, and the breakage is hard to test for because both paths LOOK right when you spot-check. Engineering velocity tax: every couple of months, a server-rendered fragment renders something the client `toElement` can't parse cleanly, the breakage is hard to repro, and the fix is one of (a) work around in the JSX, (b) `raw()` it as a literal string, (c) restructure so the fragment never crosses the boundary.

## 62.2 Two options surveyed

### Option A — Test harness + targeted hardening

Build a regression harness that exercises `jsx-runtime.ts` against both render targets and asserts they produce equivalent DOM trees for a corpus of representative JSX (~50 cases covering SVG, namespaces, void tags, escaping, entity edge cases, custom attrs). When divergence is found, fix the runtime / `toElement` to handle the case. Keeps the dual-target architecture; just makes the boundaries explicit + tested.

**Pros:**
- Incremental, low-risk, doesn't change the architecture.
- Buys immediate confidence on the corpus we think to test.

**Cons:**
- Doesn't actually fix the class of bug — only catches divergences we think to test for. New edge cases will keep slipping in.
- The hardening fixes accumulate as a long tail of "if-tag-is-svg-then…" branches inside `toElement`. Each one is small; together they erode the runtime's compactness (which was a stated win in HS-8165).

### Option B — Unified runtime, single source of truth ✅ recommended

The JSX runtime emits an internal AST (lightweight — just `{tag, props, children}` objects). Two consumers walk the AST:

- `astToHtml(node)` for the server (today's `SafeHtml.toString()` semantics).
- `astToDom(node)` for the client — builds DOM nodes directly via `document.createElement` / `createElementNS` (SVG namespace correctly applied), `setAttribute`, `appendChild`. **Skips the `innerHTML` round-trip entirely.**

Both functions are pure and small. Tests assert that for any JSX input, `astToHtml(input).then(parse)` is equivalent to `astToDom(input)` for a comprehensive corpus.

**Pros:**
- Eliminates the bug class permanently. SVG just works because `astToDom` knows the namespace context.
- Custom attributes route through `setAttributeNS` / `setAttribute` directly — no parser-quirk surface area.
- Whitespace is preserved exactly because `astToDom` builds text nodes from the AST instead of parsing them out of HTML.
- `toElement(<jsx />)` becomes a thin wrapper around `astToDom` — most call sites unchanged.
- Server-side `SafeHtml` consumers are unchanged.
- The unified-runtime shape is also the more interesting open-source artifact (HS-8165 mentions you might open-source the JSX runtime). A self-contained runtime that compiles JSX to either HTML strings OR DOM nodes via a tiny shared AST is a clean story.

**Cons:**
- Bigger one-time change. Every callsite that consumed `SafeHtml.toString()` for `innerHTML` would need to switch to `astToDom`.
- `astToDom` adds ~50–100 lines of DOM ops to the client bundle.
- A few callsites may rely on `innerHTML`-parsing quirks (e.g. parser-normalised whitespace, attribute auto-completion); those need explicit fixes during migration.

## 62.3 Recommendation

**Option B.** It's more work upfront (~1.5–2 days) but it permanently fixes the divergence bug class. The current pattern of `innerHTML`-roundtrip-then-querySelector is clever but always going to be subtly fragile. Building DOM directly is what every modern framework does for a reason.

The HS-8165 investigation explicitly called out the dual-target divergence as one of three "honest pain points the current runtime DOES have" — Options 60 and 61 fix the other two; Option B here closes the third.

## 62.4 AST shape

Lightweight. The exact API tunes during Phase 1; the conceptual shape:

```ts
// src/jsx-runtime/ast.ts
export interface JsxNode {
  tag: string | symbol;            // tag name OR a Fragment marker
  props: Record<string, unknown>;  // attributes + event handlers + className/style
  children: JsxChild[];
}

export type JsxChild =
  | JsxNode
  | string                         // text — auto-escaped by both consumers
  | { __raw: string }              // pre-escaped HTML (today's `raw(html)`)
  | null | undefined | false | true;
```

Three rules:

1. **Plain string children are auto-escaped.** Same as today.
2. **`raw(html)` produces a `{__raw}` marker.** `astToHtml` emits it verbatim; `astToDom` parses it via a one-off `<template>` element + adopts the resulting nodes (the only `innerHTML` use in the new runtime, scoped to the explicit raw escape hatch).
3. **`null` / `undefined` / `false` / `true` children are skipped.** Same as today — keeps `{showFoo && <Foo />}` ergonomic.

Backwards compatibility: `JsxNode.toString()` calls `astToHtml(this)`, so every existing server-side callsite that calls `.toString()` keeps working. `SafeHtml` is preserved as a wrapper that holds either a pre-rendered string OR a `JsxNode` and renders lazily.

## 62.5 `astToDom` — the new client path

Walks the AST, constructs DOM nodes directly:

- **Tag** → `document.createElement(tag)` for HTML, `document.createElementNS(SVG_NS, tag)` when inside an SVG subtree (tracked via a closure flag set when entering `<svg>`).
- **Props** → routed by name:
  - `className` → `el.setAttribute('class', value)`.
  - `style: string` → `el.setAttribute('style', value)`. `style: object` → individual `el.style[k] = v` (Phase 1 may keep this string-only and revisit).
  - `on*` handler functions → `el.addEventListener(name.toLowerCase().slice(2), fn)`. (Today's runtime already handles this server-side as a no-op + warning; client-side wires it up properly.)
  - `xlink:*` / `xml:*` → `setAttributeNS` with the right namespace.
  - Boolean false → omit. `true` → empty-string attribute (HTML boolean shape).
  - Everything else → `setAttribute(name, String(value))`.
- **Children** → recursive `astToDom`; text → `document.createTextNode(text)`; `{__raw}` → adopted via a one-off `<template>` (or `<svg>` if in SVG context).

Pure function. No globals. Testable in happy-dom directly.

## 62.6 Migration plan

### Phase 1 — internal AST + dual consumers (HS-8241)

- Refactor `jsx-runtime.ts` so `jsx(tag, props)` returns a `JsxNode` AST object. `JsxNode.toString()` calls `astToHtml` so every existing server callsite is unchanged.
- Add `astToDom(node)` as a new export.
- Add an equivalence test harness: a corpus of ~50 JSX cases, each asserted via "render via `astToHtml` + parse → DOM" === "render via `astToDom` → DOM" (deep DOM equality).
- `toElement` keeps using `innerHTML` for now — Phase 1 lands the new path without flipping any callsites. Goal is to validate the AST + the equivalence harness in isolation.

### Phase 2 — switch `toElement` to `astToDom` (HS-8242)

- Flip `toElement` to call `astToDom` directly when given a `JsxNode`, fall back to the legacy `innerHTML` path when given a `SafeHtml` that was constructed via `raw()`-only (no AST inside). Most callsites are no-op; a few will start working correctly for the first time.
- Run the full e2e + unit test suite. Investigate any failures — they're likely the "callsite depended on `innerHTML` parsing quirk" class called out as a risk.
- Bundle-size measurement: expectation is +1–2 KB min+gz for `astToDom`. Verify before broad rollout.

### Phase 3 — equivalence test harness in CI (HS-8243)

- Document the corpus + add it to CI so regressions show up immediately.
- Add a lint rule (or runtime guard) that warns on direct `innerHTML =` assignments outside the explicit raw-html allowlist (xterm parking, `<template>` adoption inside `astToDom`, etc.).
- Phase 3 is the "make sure this stays working" phase. Once it lands, the divergence bug class is closed.

**HS-8243 shipped 2026-05-10 in its reduced form.** Post-HS-8241 the equivalence-corpus harness is moot — kerf's `toElement` is one code path with its own upstream tests, so there's nothing to compare against. The reduced deliverable is the `no-restricted-syntax` lint rule alone, paired with a file-path allowlist for the 35 production client files (~93 callsites total) that already use `xxx.innerHTML = `. New files (and any production file not on the allowlist) trip the rule; existing usage stays lint-passing for opportunistic flag-and-fix-on-touch migration. Test files (`**/*.test.{ts,tsx}`) are exempt — `document.body.innerHTML = '<...>'` is the standard happy-dom setup pattern. CLAUDE.md's "Use `toElement()` instead of `document.createElement()`" section gained a sibling bullet documenting the convention. Full migration of the 93 existing callsites stays out of scope per HS-8243's prior reduced-scope notes (multi-day refactor with real regression risk; per-callsite verification needed).

## 62.7 What stays the same

- The JSX surface that callers see (`<div className="foo">{children}</div>`) — unchanged.
- Server-side `SafeHtml` API — unchanged from the consumer's view (`.toString()` still works).
- `raw(html)` for pre-rendered HTML strings — unchanged.
- All existing JSX call sites — unchanged.
- `pages.tsx` + `components/layout.tsx` — unchanged.
- The defensive 'JSX: DOM elements cannot be passed as children' throw (HS-6341 / HS-6342) — preserved; the AST has no slot for raw DOM nodes as children.

## 62.8 Risks

- **Callsites depending on `innerHTML` parsing quirks.** A `<table>` without a `<tbody>` gets one auto-inserted by the parser; a `<select>` flattens whitespace. Anywhere we relied on this implicitly, `astToDom` will surface a mismatch. **Mitigation:** Phase 3's regression corpus running against both paths flags divergences before rollout; Phase 2's e2e suite is the second net.
- **Bundle-size impact.** `astToDom` is ~50–100 lines of DOM ops; expectation is small but worth measuring as part of HS-8241. CI bundle-size gate from §60 catches regressions across the whole client bundle.
- **Style as object vs string.** Today most callsites pass `style="…"` as a string. If Phase 1 supports object form, that's a small extra surface. Defer to "string-only" in Phase 1; revisit if a real consumer wants object form.
- **Event handler memory** — `astToDom` calls `addEventListener` directly. Detached subtrees should drop listeners with the GC because we don't keep a separate registry; verify there's no listener leak in Phase 2's e2e.
- **Server-side parity** — `astToHtml` must produce byte-identical output to today's `jsx-runtime.ts` for every input in the corpus. Any drift breaks server-rendered initial paint. Phase 1's harness asserts this directly.

## 62.9 Open questions / deferred decisions

- **Fragment shorthand `<>...</>`** — currently supported via the JSX runtime's Fragment symbol. Stays. AST represents a fragment as `{tag: FRAGMENT_SYMBOL, …}`; `astToDom` returns a `DocumentFragment`.
- **JSX boolean attributes** (`<button disabled>`) — already handled per §62.5. No new behaviour.
- **Server-side `astToDom`** — pointless. Server uses `astToHtml`. If anyone tries to import `astToDom` from server code, the import resolves to a stub that throws. Easy with `tsup`'s aliasing or `package.json` `exports` map.
- **Reactivity integration** — orthogonal to §60. `astToDom` produces real DOM nodes; signals can `bindText` / `bindAttr` against them just as they do today. No special integration needed.
- **AST visitor pattern** — out of scope. If a future use case wants generic AST transforms (e.g. dev-mode injection of accessibility lints), a small `walk(node, visitor)` helper drops in trivially. Don't pre-build it.
- **Compatibility with `SafeHtml` consumers that introspect** — `SafeHtml` instances surface a `.toString()` method today; that stays. A few callsites read internal state (e.g. `.value` for length-checking); if any do, Phase 1 finds them and keeps them working.

## 62.10 Cost estimate

- Phase 1 (HS-8241): ~1 day. AST shape + `astToHtml` parity + `astToDom` skeleton + equivalence harness + corpus.
- Phase 2 (HS-8242): ~half a day plus regression smoke testing across the full e2e suite.
- Phase 3 (HS-8243): ~half a day for the CI integration + lint rule.

Total: 2 days of focused work + smoke testing.

## 62.11 Status & follow-up tickets

- **HS-8168 — this design.** Status: design only; closes once the doc lands.
- **HS-8241 — Phase 1: internal AST + dual consumers + corpus.** Doesn't change `toElement` yet.
- **HS-8242 — Phase 2: switch `toElement` to `astToDom`.** Atomic flip; full e2e validation.
- **HS-8243 — Phase 3: equivalence harness in CI + lint rule.** Shipped 2026-05-10 in reduced form: lint rule only (the equivalence harness was moot post-HS-8241's kerf swap), with a file-path allowlist for the 35 production client files that already use `innerHTML`. New code is protected; existing usage migrates opportunistically on-touch.

## 62.12 Cross-refs

- [§60. Fine-grained reactivity primitive](60-reactivity-primitive.md) — independent track. Signals don't change anything about how DOM is constructed; the two designs compose.
- [§61. Composable testable stores](61-composable-stores.md) — independent track. No dependency either direction.
- HS-8165 — investigation that produced the verdict driving this doc.
- HS-6341 / HS-6342 — defensive throw for DOM-passed-as-JSX-children; preserved in §62.7.
- §17 of `docs/ai/code-summary.md` — JSX runtime entry; bundle-size + helper-location reverse index.
