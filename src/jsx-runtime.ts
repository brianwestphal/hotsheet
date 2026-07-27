/**
 * HS-9450 (§62) — Hot Sheet's JSX runtime, now a thin re-export of kerf's.
 *
 * This file used to BE the runtime: ~230 lines that rendered JSX to HTML strings,
 * including a ~180-entry camelCase→kebab `ATTR_ALIASES` table. It predated the kerf
 * adoption (HS-8315, §60/§61), and §62 deliberately took the minimal path — route
 * `toElement` through `kerfjs::toElement` to close the SVG-namespace bug class —
 * rather than swapping the runtime as well. That left Hot Sheet maintaining a
 * parallel implementation of something its own dependency already shipped.
 *
 * The file survives as the **seam** rather than the implementation. Keeping it
 * means:
 *  - the ~46 modules that `import { raw, SafeHtml } from '../jsx-runtime.js'` don't
 *    churn, and neither do the three `#jsx` alias points (tsconfig `paths`,
 *    `tsup.config.ts`, `vitest.config.ts`);
 *  - the swap seam docs/60 §60.4 and §62 describe stays where it is, so a future
 *    implementation change is again a one-file edit.
 *
 * What the swap buys, beyond deleting the duplicate:
 *  - **kerf's XSS hardening** (kerf 1.0), which the local runtime never had. It
 *    escaped values but did not validate attribute NAMES, reject `on*` attributes,
 *    or screen `javascript:`/`vbscript:`/script-executing `data:` URLs. Before this
 *    change `<a href="javascript:alert(1)">` and `<div onclick="alert(1)">` both
 *    rendered verbatim; kerf refuses them.
 *  - **Real JSX typing.** The local `JSX.IntrinsicElements` was
 *    `[elemName: string]: Record<string, unknown>` — every tag and attribute
 *    typechecked vacuously. kerf ships typed intrinsics. Custom elements and
 *    non-standard attributes now need declaration merging into
 *    `'kerfjs/jsx-runtime'` (see `src/jsx-augment.d.ts`), which is kerf hard rule 12.
 *
 * Equivalence is pinned by `src/jsxRuntimeCorpus.test.ts` — the ~50-case corpus §62
 * scoped and never built. It was written against the OLD local runtime, passed, and
 * then had to pass unchanged against kerf's. Divergences it caught are documented
 * there.
 */
export {
  Fragment,
  isSafeHtml,
  jsx,
  jsxDEV,
  jsxs,
  raw,
  SafeHtml,
} from 'kerfjs/jsx-runtime';
// `JSX` is a types-only namespace, so `isolatedModules` requires the type form.
// It has to be re-exported at all because `jsxImportSource: "#jsx"` makes the
// compiler resolve `JSX.Element` / `JSX.IntrinsicElements` through THIS module.
export type { JSX } from 'kerfjs/jsx-runtime';

/**
 * HS-9450 — spread this instead of hand-writing the `draggable` attribute.
 *
 * `draggable` is an **enumerated** attribute (`"true"` / `"false"`), not a boolean
 * one, but kerf types it `AttrLike<boolean>`. Emitting the boolean produces a bare
 * `draggable`, and a bare `draggable` is the *invalid value* → the `auto` state →
 * **not draggable**. Measured in Chromium rather than inferred:
 *
 *   `<div draggable>`         → `.draggable === false`   (what `draggable={true}` renders)
 *   `<div draggable="true">`  → `.draggable === true`
 *
 * This codebase has already been bitten by exactly that (HS-8431 silently broke
 * project-tab reordering; `projectTabs.test.ts` still guards it), so the string form
 * is load-bearing and must not be "simplified" into a boolean to satisfy a type.
 *
 * Typed `Record<string, string>` deliberately: it is the one shape that spreads into
 * kerf's typed intrinsics without a cast, which keeps the whole workaround free of
 * `as`. kerf already widened `contenteditable` and lowercase `spellcheck` for this
 * same enumerated-attribute reason and missed `draggable` — when that is fixed
 * upstream, delete this and set the attribute directly.
 */
export const DRAGGABLE_TRUE: Record<string, string> = { draggable: 'true' };
