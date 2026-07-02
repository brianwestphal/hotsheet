/**
 * HS-9277 — session-scoped store of TRANSIENT terminal renames, shared by the
 * drawer tab strip (`terminalTabContextMenu.tsx`) and the terminal dashboard
 * (`terminalDashboardTiles.tsx`).
 *
 * A terminal rename (right-click → Rename…) is deliberately transient (HS-6668):
 * it doesn't persist to `settings.json`, and a page reload or project-tab switch
 * restores the configured name. Before this module each surface kept its own
 * in-memory rename (the drawer on its `TerminalInstance.config.name`, the dashboard
 * on the tile DOM), so a rename in one view wasn't visible in the other — renaming
 * in a project tab left the dashboard tile showing the old name.
 *
 * This holds the transient names centrally, keyed by `(projectSecret, terminalId)`
 * — terminal ids (`default` / `second` / `dyn-*`) are only unique WITHIN a project,
 * and the dashboard shows every project at once, so the secret is part of the key.
 * A rename dispatches `hotsheet:terminal-renamed` so any open surface updates live.
 * The map is module-level (resets on reload) and cleared on project switch, exactly
 * matching the "transient" contract.
 */

const KEY_SEP = '::';
const transientNames = new Map<string, string>();

function keyFor(secret: string, id: string): string {
  return `${secret}${KEY_SEP}${id}`;
}

/** The event fired when a terminal's transient name is set or cleared. `detail`
 *  carries the `(secret, id)` so listeners can cheaply target the right surface. */
export const TERMINAL_RENAMED_EVENT = 'hotsheet:terminal-renamed';

/** Set (non-empty) or clear (empty string) the transient name for a terminal and
 *  notify open surfaces. Clearing reverts the terminal to its configured name. */
export function setTransientTerminalName(secret: string, id: string, name: string): void {
  const k = keyFor(secret, id);
  if (name === '') transientNames.delete(k);
  else transientNames.set(k, name);
  document.dispatchEvent(new CustomEvent(TERMINAL_RENAMED_EVENT, { detail: { secret, id } }));
}

/** The transient name for a terminal, or undefined when none is set (the caller
 *  falls back to the configured / derived name). */
export function getTransientTerminalName(secret: string, id: string): string | undefined {
  return transientNames.get(keyFor(secret, id));
}

/** Clear every transient rename — called on project switch so the "a project-tab
 *  switch restores the original name" contract holds across both surfaces. */
export function clearTransientTerminalNames(): void {
  transientNames.clear();
}

/** Test-only reset. */
export function _resetTransientTerminalNamesForTests(): void {
  transientNames.clear();
}
