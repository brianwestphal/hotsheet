# 35. Terminal theme + font (HS-6307)

## 35.1 Overview

Every xterm instance in Hot Sheet (drawer terminals, dashboard tiles, dashboard dedicated view) renders with a configurable **appearance** — color palette, font family, font size. Appearance is resolved per-terminal from three layers (session override → configured override → project default → hard-coded fallback) and can be changed live via a small gear-button popover on the terminal toolbar.

**Core promises:**

1. A fixed registry of 11 curated themes ships with the app; adding more is a one-entry data change (no branching, no CSS).
2. Font families come from Google Fonts — any mono-spaced face listed in `TERMINAL_FONTS` is fetched at runtime via a dynamic `<link>` tag. A "System" fallback keeps the existing OS-mono stack.
3. Every terminal has its own appearance. The project sets a default; configured terminals can override in `settings.json`; dynamic terminals carry a session-only override.
4. Changes made via the gear popover apply instantly — no PTY restart needed. xterm's `options.theme` / `options.fontFamily` / `options.fontSize` are reassigned live and the canvas re-renders.
5. The same appearance applies across every surface the terminal appears in (drawer, dashboard tile, dashboard dedicated view).

## 35.2 Theme registry

Themes live in `src/client/terminalThemes.ts` as `TERMINAL_THEMES: TerminalTheme[]` — an ordered array. Each entry is a plain data record:

```ts
interface TerminalTheme {
  id: string;            // slug, stored in settings — never change after ship
  name: string;          // display label in the popover
  isDark: boolean;       // drives the accent-tinted selection alpha choice
  foreground: string;
  background: string;
  cursor: string;
  cursorAccent: string;  // the character color *under* the block cursor
  selectionBackground: string;
  selectionInactiveBackground: string;
  black: string;         // ANSI 0
  red: string;           // ANSI 1
  green: string;         // ANSI 2
  yellow: string;        // ANSI 3
  blue: string;          // ANSI 4
  magenta: string;       // ANSI 5
  cyan: string;          // ANSI 6
  white: string;         // ANSI 7
  brightBlack: string;   // ANSI 8
  brightRed: string;     // ANSI 9
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}
```

**Shipped themes (v1):**

1. **`default`** — the legacy app-derived palette (background = `--bg`, foreground = `--text`, cursor = `--accent`, selection = accent with alpha). This is the theme every existing terminal has been rendering with since HS-7330, and it remains the fallback when no theme is otherwise resolved. Because it depends on CSS custom properties, `getThemeById('default')` returns a *builder* that reads the CSS at apply time rather than a static record — the same `readXtermTheme()` path as before, wrapped so it matches the `TerminalTheme` shape.
2. **`dracula`** — canonical Dracula palette.
3. **`solarized-dark`** — Ethan Schoonover's Solarized (dark variant).
4. **`solarized-light`** — Solarized (light variant).
5. **`nord`** — Arctic, north-bluish color palette.
6. **`gruvbox-dark`** — warm, retro groove.
7. **`monokai`** — classic Monokai.
8. **`one-dark`** — Atom's One Dark.
9. **`tomorrow-night`** — Chris Kempson's Tomorrow Night.
10. **`github-dark`** — GitHub's dark default.
11. **`github-light`** — GitHub's light default.

**Adding a theme later is a single data-file edit.** Append an entry to `TERMINAL_THEMES`; the popover picks it up automatically (the `<select>` is rendered from the same array). No switch statements, no CSS, no UI changes required. The `id` field must be stable — changing a theme's `id` invalidates any `settings.json` that referenced it and falls back to `default`.

### 35.2.1 Applying a theme to xterm

Helper `themeToXtermOptions(theme: TerminalTheme): ITheme` in `terminalThemes.ts` maps the `TerminalTheme` shape to xterm's `ITheme`. The `default` theme's build step reads the CSS at call time — every other theme is a static record.

To apply dynamically, set `term.options.theme = themeToXtermOptions(theme)`. xterm triggers a canvas re-render on the next frame.

## 35.3 Font registry

Fonts live in `src/client/terminalFonts.ts` as `TERMINAL_FONTS: TerminalFont[]` — same pattern as themes.

```ts
interface TerminalFont {
  id: string;                 // slug, stored in settings
  name: string;               // display label in the popover
  family: string;             // CSS font-family value (may be a stack for System)
  googleFontsName: string | null;   // null for System; otherwise the Google Fonts family slug
}
```

**Shipped fonts (v1):**

1. **`system`** — `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace` (the existing hard-coded stack). `googleFontsName: null` — no network fetch.
2. **`jetbrains-mono`** — "JetBrains Mono"
3. **`fira-code`** — "Fira Code"
4. **`source-code-pro`** — "Source Code Pro"
5. **`ibm-plex-mono`** — "IBM Plex Mono"
6. **`roboto-mono`** — "Roboto Mono"
7. **`inconsolata`** — "Inconsolata"
8. **`ubuntu-mono`** — "Ubuntu Mono"
9. **`space-mono`** — "Space Mono"
10. **`anonymous-pro`** — "Anonymous Pro"
11. **`cascadia-code`** — "Cascadia Code" (shipped on Google Fonts since 2024)

### 35.3.1 Loading a Google Font

`loadGoogleFont(font: TerminalFont): Promise<void>` is idempotent and race-safe:

1. If `font.googleFontsName === null`, resolve immediately (System font is always available).
2. Else, check the module-level `loadedFonts: Map<id, Promise<void>>` — if a load is already in flight or complete, return the existing promise.
3. Otherwise, append `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=<encoded>&display=swap">` to `<head>` once per font.
4. Wait for `document.fonts.load('13px "<family>"')` — the browser resolves this once the actual glyph bytes have been fetched.
5. Cache the promise in `loadedFonts` so subsequent calls for the same font are O(1).

The Tauri WKWebView allows fetches to `fonts.googleapis.com` + `fonts.gstatic.com` by default. In a browser context the same fetch works directly. No CSP / capability changes required.

**Failure mode.** If the network is offline or the Google Fonts CDN is unreachable, `document.fonts.load()` resolves with an empty `FontFace[]` and xterm falls back to the System stack via the CSS font-family inheritance chain (the terminal's container has a `font-family: <TerminalFont.family>, <System stack>, monospace` cascade, so a missing web font lands on Menlo / SF Mono without an error). The popover still shows the font as "selected" — we don't round-trip the failure to the UI in v1.

### 35.3.2 Font size

Integer pixel size, clamped to `[8, 32]`. Stored as `fontSize: number`. xterm applies the value via `term.options.fontSize = N`.

## 35.4 Inheritance and resolution

Three layers, checked in order:

1. **Session override** (dynamic terminals only) — a `WeakMap<TerminalId, Partial<TerminalAppearance>>` kept in client memory. Cleared on PTY restart, tab close, and page reload.
2. **Configured override** (configured terminals only) — optional `theme` / `fontFamily` / `fontSize` fields on the `TerminalConfig` entry in `settings.json`.
3. **Project default** — the `terminal_default` object in `.hotsheet/settings.json`:

   ```json
   "terminal_default": {
     "theme": "default",
     "fontFamily": "system",
     "fontSize": 13
   }
   ```

4. **Hard-coded fallback** — `{ theme: 'default', fontFamily: 'system', fontSize: 13 }`. Matches the pre-HS-6307 behaviour so terminals look identical on first run after the upgrade.

Resolution is field-wise: each of `theme`, `fontFamily`, `fontSize` is picked independently from the highest layer that sets it. A configured terminal with `{ theme: 'dracula' }` but no font override inherits `terminal_default.fontFamily` (else System).

`resolveAppearance({ projectDefault, configOverride, sessionOverride })` lives in `src/client/terminalAppearance.ts` with unit tests for every permutation.

## 35.5 Gear-button popover

Every terminal toolbar (drawer + dashboard dedicated view) gains a **gear icon** (Lucide `settings`) immediately to the right of the existing clear-terminal button. Clicking it opens a small floating popover anchored below the button:

```
┌────────────────────────────┐
│ Theme       [Dracula     ▾] │
│ Font        [JetBrains…  ▾] │
│ Font size   [13]   [−][+]   │
│                            │
│ Reset to project default    │
└────────────────────────────┘
```

- **Theme select.** `<select>` with one `<option>` per entry in `TERMINAL_THEMES`. Current theme pre-selected. Changing it fires `applyAppearance` immediately.
- **Font select.** `<select>` with one `<option>` per entry in `TERMINAL_FONTS`. On change, `loadGoogleFont(next)` is awaited (the popover shows a brief "Loading…" status on the font row) and then applied.
- **Font size.** Numeric input + `−` / `+` buttons stepping by 1 px. Clamped to `[8, 32]`. Applied on every change.
- **Reset link.** Removes any session/configured override for THIS terminal and re-resolves from the project default. For a configured terminal the `theme` / `fontFamily` / `fontSize` fields are deleted from its `settings.json` entry; for a dynamic terminal the session-override entry is deleted.

**Persistence per terminal type:**

- **Configured terminals.** Changes made in the popover persist to `settings.json` via `PATCH /api/file-settings` — the same debounced-save path the existing terminals settings UI uses. The `terminals[]` entry for that id gets updated `theme` / `fontFamily` / `fontSize` fields.
- **Dynamic terminals.** Changes are stored in the session-override map only. PTY restart (Stop → Start) preserves the override; page reload clears it. This matches the session-only scope of dynamic terminals themselves.

**Dismissal.** Click outside the popover, press Escape, or click the gear button again. Capture-phase document listener pattern (matches the existing OSC 133 popover in §32).

**Per-view anchoring.** The popover is anchored to the gear button that opened it, so the drawer instance opens below the drawer toolbar and the dashboard dedicated-view instance opens below the dedicated toolbar. Only one popover is open at a time — opening a second gear dismisses the first.

**Settings-outline parity (HS-7562).** The Edit Terminal dialog in `terminalsSettings.tsx` (the per-project terminals outline editor in Settings → Terminal) gains a collapsible **Appearance** section below the existing Name / Command / CWD / Lazy fields, with the same three controls (Theme select, Font select, Font size numeric input). The section auto-opens when the entry already has any of `theme` / `fontFamily` / `fontSize` set, so the user sees the live values without needing to click; it's collapsed by default for entries that don't override appearance. Per-control inheritance UX (per the user's HS-7562 clarifying answer): no separate sentinel "Use project default" option — the dropdowns simply pre-select whatever the currently-resolved value is (the project default if no override exists, or the saved override if one does), and whatever the user picks on Save is written verbatim as a per-terminal value. This is intentionally simple: a user who didn't touch the controls but hits Save still ends up with their per-terminal value matching the project default's value at dialog-open time, decoupling future project-default changes from this terminal. To reset back to inheriting, the user clears the override by deleting the `theme` / `fontFamily` / `fontSize` keys directly in `settings.json`; an explicit "Reset" affordance in the dialog is a deliberate future enhancement. On Save the dialog dispatches a new `hotsheet:terminal-config-changed` custom event with `{terminalId}` payload — `terminal.tsx`'s `initTerminal` listens and calls `reapplyAppearance(inst)` for the matching mounted instance so the live xterm re-resolves without a page reload (mirrors the existing `hotsheet:terminal-default-changed` flow for the project-default panel).

## 35.6 Project-default appearance UI

Settings → Terminal tab gains a new **"Default appearance"** panel above the existing terminals list:

```
Default appearance
  Theme       [Default             ▾]
  Font        [System               ▾]
  Font size   [13]   [−][+]
```

These write through to `terminal_default` in `settings.json`. Changing the default immediately re-resolves every live terminal's appearance (the client dispatches a `hotsheet:terminal-default-changed` custom event that each mounted xterm instance listens for).

The per-terminal editor dialog (the existing "Edit Terminal" overlay in `terminalsSettings.tsx`) grows an **"Appearance override"** section with the same three controls plus a **"Use project default"** checkbox. When checked, the override fields are cleared; when unchecked, the current values become the override. This is the per-terminal counterpart to §35.5's popover for users who prefer configuring from Settings.

## 35.7 Cross-surface consistency

Every xterm instance resolves appearance from the same three-layer stack:

- **`src/client/terminal.tsx` `mountXterm`** (drawer) — reads `terminal_default` + per-terminal config + session-override at mount time.
- **`src/client/terminalDashboard.tsx` `mountTileXterm`** (grid tiles) — same resolution; a tile and its drawer counterpart always look identical.
- **`src/client/terminalDashboard.tsx` `enterDedicatedView`** (dashboard dedicated pane) — same resolution.

When the user changes appearance in one surface, every surface for that terminal picks it up — the terminal's `TerminalInstance` holds the currently-resolved appearance and every `term.options.*` assignment goes through `applyAppearanceToTerm(term, appearance)` so the three canvases stay in sync.

The existing CSS-var-derived `readXtermTheme()` (HS-7330) is replaced by a call to `themeToXtermOptions(resolvedTheme)`. For the `default` theme the two return identical values, so no terminal changes colour on upgrade.

## 35.8 Implementation notes

- **Shared module** `src/client/terminalAppearance.ts` exports:
  - `TerminalAppearance` type.
  - `DEFAULT_APPEARANCE: TerminalAppearance`.
  - `resolveAppearance(layers): TerminalAppearance`.
  - `applyAppearanceToTerm(term, appearance): Promise<void>` — loads the font first, then assigns `term.options.theme`, `fontFamily`, `fontSize` in that order.
  - `subscribeToDefaultChanges(handler)` — listens for the `hotsheet:terminal-default-changed` event so mounted xterms re-resolve.
- **No server-side code changes** — appearance is purely a client-side concern (xterm renders in the browser). The server-side `settings.json` read/write path already round-trips unknown fields untouched (`file-settings` writes the full payload).
- **Session-override map** `sessionAppearanceOverrides: Map<TerminalId, Partial<TerminalAppearance>>` lives at module scope in `terminalAppearance.ts`. Cleared on page reload.
- **Font loading prefetch.** On project load the client kicks off `loadGoogleFont` for the project's resolved default font so the initial drawer-terminal mount doesn't flash System glyphs for a frame.

## 35.9 Out of scope (v1)

Deliberately left for follow-ups — file tickets if they become missed:

- **Custom user themes.** Users can't define their own palette in v1; the registry is code-owned. Follow-up ticket.
- **Transparent / wallpaper backgrounds.** xterm supports it via `theme.background: 'rgba(...)'` but integrating with Tauri window transparency is a larger rabbit hole.
- **Font ligatures toggle.** xterm 5 supports ligatures but requires an addon; opt-in ligatures (on by default for fonts that ship them, like Fira Code and JetBrains Mono) is a follow-up.
- **Bold / italic font-weight overrides.** xterm uses one weight for bold; user-specified bold weights are out of scope.
- **Non-Google-Fonts font families.** v1 is Google-Fonts-only per the HS-6307 feedback. Loading a locally-installed font family by name is a follow-up.
- **Dashboard tile gear popover.** Grid tiles are preview-only (§25) and don't get their own gear button; appearance is changed from the drawer or the dedicated view. Follow-up ticket if missed.
- **Keyboard shortcut to open the popover.** No shortcut in v1; click the gear.
- **Per-terminal appearance migration history.** Changing a theme's `id` invalidates saved overrides; there's no migration path. Don't rename theme ids after shipping them.

## 35.10 Testing

**Unit.**

- `terminalThemes.test.ts` — every theme in `TERMINAL_THEMES` has the full 17-field shape, `getThemeById('dracula')` returns Dracula, `getThemeById('nonexistent')` returns `null`, `themeToXtermOptions` produces a valid `ITheme` with all ANSI fields, `default` theme re-reads CSS at apply time (DOM-stubbed).
- `terminalFonts.test.ts` — every font has a valid `family` string, System has `googleFontsName: null`, Google Fonts URL is built correctly, `loadGoogleFont` is idempotent across concurrent calls, System short-circuits.
- `terminalAppearance.test.ts` — `resolveAppearance` picks each layer correctly (session > config > default > fallback) field-by-field, partial overrides inherit unset fields, unknown theme id falls back to `default` (with a console warning), unknown font id falls back to System.

**E2E.**

- `e2e/terminal-appearance.spec.ts` — open the drawer, click the gear icon, select "Dracula" from the theme dropdown, assert xterm's background canvas becomes Dracula's `#282a36`. (Canvas colour read via a `page.evaluate` that samples the rendered pixel.)

**Manual.**

- `docs/manual-test-plan.md` §22 gains entries: gear popover open / close dismissal, font switch applies live, font-size step clamps at 8 and 32, Reset to project default, project-default change re-applies across all open terminals, override persists across page reload for configured terminals, session override cleared on reload for dynamic terminals.

## 35.11 Cross-references

- [22-terminal.md](22-terminal.md) — base embedded-terminal feature; the appearance popover sits on the same toolbar.
- [25-terminal-dashboard.md](25-terminal-dashboard.md) — dashboard tiles and dedicated view share the same appearance resolution.
- [32-osc133-jump-and-popover.md](32-osc133-jump-and-popover.md) — hover popover pattern (dismissal, anchoring) reused by the appearance popover.
- [HS-7330](https://example.com) — the CSS-var-derived theme this feature generalises. The `default` theme preserves the HS-7330 behaviour exactly.
- **Tickets:** HS-6307 (this doc).
