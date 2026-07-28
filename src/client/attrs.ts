/**
 * HS-9454 — Hot Sheet's own JSX attribute helpers.
 *
 * Split out of `jsx-runtime.ts` when that seam was deleted and the codebase moved to
 * importing `kerfjs` directly. This is OUR workaround for a kerf typing bug, not part
 * of any runtime's surface, so it belongs beside the client code that uses it.
 */

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
