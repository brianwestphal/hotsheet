/**
 * HS-9450 — declaration merging into kerf's JSX namespace (kerf hard rule 12:
 * augment `'kerfjs/jsx-runtime'`, never a global JSX namespace).
 *
 * Only for tags/attributes kerf's typed intrinsics don't cover yet. ADDING a tag
 * merges cleanly; WIDENING an existing attribute does not — TS requires merged
 * property declarations to have identical types, and `skipLibCheck` hides the
 * resulting conflict error, so an attempted widening silently does nothing. That is
 * why `draggable` is handled by the `DRAGGABLE_TRUE` spread in `jsx-runtime.ts`
 * rather than here.
 */
import type { KerfBaseAttrs } from 'kerfjs/jsx-runtime';

declare module 'kerfjs/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      /** Rendered by `components/pairPage.tsx` for the no-JS fallback. kerf's tag
       *  table omits it; it renders correctly at runtime, this is types only. */
      noscript: KerfBaseAttrs;
    }
  }
}
