# 56. Magnified terminal-grid navigation

HS-8028. While a terminal tile is centered (single-click overlay) or dedicated (double-click full-pane) in the §25 dashboard or §36 drawer-grid, **Shift+Cmd+Arrow** on macOS / **Shift+Ctrl+Arrow** on Linux/Windows switches the magnified target to the next tile in the indicated direction. Up / down / left / right are computed from each tile's bounding-rect centroid using a perpendicular-weighted cone metric.

## 56.1 Why

Pre-fix the user had to dismiss the centered overlay (Esc / backdrop click) AND single-click another tile, OR exit the dedicated view (Back button / Esc) AND double-click another tile, every time they wanted to compare two terminals side-by-side or step through a project's terminal pool. HS-8028 collapses that into a single keystroke per step.

## 56.2 Decisions

- **Chord shape.** Shift layered on top of the platform primary modifier (Cmd on macOS, Ctrl on Linux/Windows). Stays out of the way of `isJumpShortcut` (Cmd/Ctrl+Up/Down for OSC 133 prompt-marker jumps within a single terminal — HS-7269). The wrong-platform modifier passes through unchanged so e.g. macOS Shift+Ctrl+Arrow still reaches xterm / shell / vim.
- **Direction algorithm.** For each candidate tile, compute the centroid offset `(dx, dy)` from the source tile. Direction filter: `right` → `dx > 0`, `left` → `dx < 0`, `down` → `dy > 0`, `up` → `dy < 0`. Cone metric: `Math.abs(parallel) + Math.abs(perpendicular) * 3` — perpendicular distance weighted 3× higher than parallel so a same-row neighbour beats a diagonal one when both are equidistant by raw Euclidean.
- **Active modes.** Centered AND dedicated. The bare grid (no magnification) doesn't bind the listener — there's no "current magnified tile" to navigate from.
- **Dedicated context.** When pressed in dedicated mode, the swap exits the current dedicated view and enters dedicated for the next tile **with no `priorCenteredTile`**. The user can ⎋ back to the bare grid afterwards. The HS-8028 ticket's "use whatever context the user was in before going fullscreen" reads as: navigation ordering follows the underlying grid layout (which it does — direction is computed from each tile's grid-position rect). Returning to a stale centered state mid-swap would flash and feel wrong.
- **Skip non-alive tiles.** Placeholders (`exited` / `not_spawned`) aren't navigation targets. Pressing Shift+Cmd+Right past a row of mixed alive + exited tiles skips the exited ones and lands on the next alive tile in that direction.

## 56.3 Implementation

### 56.3.1 `terminalKeybindings.ts`

New `isMagnifiedNavShortcut(e, isMac)` returning `'up' | 'down' | 'left' | 'right' | null`. Follows the same shape as `isJumpShortcut` (HS-7460): platform-correct primary modifier check, Alt held disqualifies, wrong-platform modifier disqualifies.

13 unit tests in `terminalKeybindings.test.ts` cover the four directions on macOS, the wrong-platform passthrough, the Alt-disqualifies guard, the no-Shift case (preserves Cmd+Arrow for OSC 133 jumps), keyup/keypress filtering, and the non-arrow rejection.

### 56.3.2 `terminalTileGrid.tsx`

The shared module gained four new helpers:

- **`bindMagnifiedNavHandler()`** — installs a single document-level keydown listener (capture phase) that filters via `isMagnifiedNavShortcut` and dispatches to `magnifyTile(next, mode)`. Idempotent — the helper checks `magnifiedNavListener !== null` and bails early.
- **`unbindMagnifiedNavHandler()`** — removes the listener. Idempotent.
- **`findNextTileInDirection(from, direction)`** — the cone-metric implementation. Iterates `tiles.values()`, filters by direction half-plane, picks the lowest distance under the perpendicular-weighted metric. Skips non-alive tiles and zero-size tiles. Returns `null` when no candidate qualifies (user pressed past the edge of the grid).
- **`magnifyTile(next, mode)`** — performs the swap. For `mode === 'center'`: synchronously uncenters the prior tile via `finishUncenterTile` (no full `uncenterTile` so the listener-bind/unbind churn doesn't fire) and `centerTile(next)`. For `mode === 'dedicated'`: clears `dedicated.priorCenteredTile = null` (so exit doesn't animate through a stale centered state), `exitDedicatedView()`, `enterDedicatedView(next, null)`.

### 56.3.3 Wiring lifecycle

- `centerTile(tile)` calls `bindMagnifiedNavHandler()`.
- `uncenterTile()` calls `unbindMagnifiedNavHandler()` only when `dedicated === null` (preserves the listener for the dedicated path when the user double-clicked an already-centered tile).
- `enterDedicatedView(tile, priorCenteredTile)` calls `bindMagnifiedNavHandler()` (idempotent — already-bound from a prior `centerTile` is fine).
- `exitDedicatedView()` calls `unbindMagnifiedNavHandler()` only when `view.priorCenteredTile === null` (otherwise the path returns to centered mode and the listener stays armed).
- `teardownAll()` calls `unbindMagnifiedNavHandler()` defensively.

### 56.3.4 Capture phase + xterm interaction

The document-level listener uses `addEventListener('keydown', ..., true)` — capture phase. This fires BEFORE the bubble-phase listeners that xterm attaches to its textarea, so `e.preventDefault()` + `e.stopPropagation()` keep xterm from translating the chord into shell escape sequences (xterm sends `\e[1;9X`-style sequences for Cmd/Shift+Arrow combos by default).

## 56.4 Tests

13 new unit tests in `src/client/terminalKeybindings.test.ts`. End-to-end navigation between magnified tiles is left to manual spot-check + a future Playwright spec — happy-dom can render the tiles but `bounding-client-rect` returns zeroes without a real layout, making the cone-metric assertion brittle without a JSDOM-style layout simulator.

## 56.5 Out of scope

- **Wraparound at grid edges.** Pressing Shift+Cmd+Right past the rightmost tile is a no-op (returns null). Wraparound to the leftmost tile of the next row could be added if the user finds the no-op annoying.
- **Plain grid (no magnified target).** Could be wired to magnify the first / last tile in the indicated direction starting from the viewport center, but the HS-8028 ticket explicitly framed this as a magnified-only behaviour.
- **Drawer pane keyboard.** The drawer pane is a single-terminal surface — no notion of grid navigation. Cmd+1 / Cmd+2 etc. (tab switching) is a separate keybinding outside HS-8028's scope.

## 56.6 Cross-refs

- §25 (terminal dashboard) — primary surface.
- §36 (drawer terminal grid) — secondary surface (same shared `mountTileGrid`).
- §54 (terminal checkout) — `magnifyTile` interacts with `enterDedicatedView` / `exitDedicatedView` which have been migrated to the checkout module's `release()` / `checkout()` flow.
- HS-7269 (`isJumpShortcut`) — the OSC 133 prompt-marker navigation shortcut, intentionally distinct (no Shift modifier) so the two coexist on the same terminal.
