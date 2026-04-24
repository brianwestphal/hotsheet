# 28. OSC 8 clickable hyperlinks (HS-7263)

## 28.1 Overview

Modern CLI tools emit OSC 8 hyperlinks so the visible text and the underlying URL differ:

```
\x1b]8;;https://github.com/foo/bar/pull/123\x07  #123\x1b]8;;\x07
```

Prior to HS-7263, Hot Sheet's terminal relied on `@xterm/addon-web-links` — a regex scan of rendered glyphs that only catches text that *looks like* a URL. OSC 8 hyperlinks were invisible to the regex because the rendered text is just "#123"; the URL never appeared on screen. `gh pr list`, `delta`, `eza`, `rg --hyperlink-format`, `ls --hyperlink=auto`, and `git log` piped through `delta` all emit OSC 8 — meaning a large chunk of the day-to-day CLI surface had non-functional hyperlinks.

This change wires xterm.js's native OSC 8 support (available since v5) by passing a `linkHandler` to the `XTerm` constructor. Activation routes through the new `openExternalUrl` helper in `src/client/tauriIntegration.tsx`, which invokes the Tauri `open_url` command in desktop builds and falls back to `window.open` in browser builds. Without this routing, a click inside Tauri's WKWebView would silently no-op (the standard `window.open` failure mode documented in CLAUDE.md §Tauri-unsafe-browser-APIs).

## 28.2 Escape format

```
\x1b]8;<params>;<URI>\x07<TEXT>\x1b]8;;\x07
```

- Opening sequence: `OSC 8;params;URI BEL`. `params` is key=value pairs (e.g. `id=abc`), typically empty. `URI` is the full URL.
- Visible text: rendered between the opening and closing sequences like normal glyphs.
- Closing sequence: `OSC 8;;BEL` (empty params, empty URI).

ST-terminated variants (`\x1b\\` instead of `\x07`) work too — xterm.js handles both.

## 28.3 Implementation

### Drawer terminal (`src/client/terminal.tsx`)

The `XTerm` constructor now passes:

```ts
linkHandler: {
  activate: (_event, text) => { openExternalUrl(text); },
},
```

xterm.js parses OSC 8 natively, stores the URL in its internal link registry, renders the visible text with a hover underline (default xterm styling), and calls our `linkHandler.activate` with `text` = URL on click.

Plain URL detection (WebLinksAddon) is also updated in the same change to route through `openExternalUrl`:

```ts
term.loadAddon(new WebLinksAddon((_event, uri) => { openExternalUrl(uri); }));
```

Without the custom handler, WebLinksAddon's default is `window.open(url, '_blank')` — a silent no-op in WKWebView and the pre-existing source of "plain URLs don't open" reports that HS-7263 incidentally fixes.

### Terminal dashboard tiles + dedicated view (`src/client/terminalDashboard.tsx`)

Both the tile-preview `XTerm` (`mountTileXterm`) and the dedicated full-viewport `XTerm` (`openDedicatedView`) receive the same `linkHandler` so activation works in every attached surface:

- **Tile previews** are scaled + non-interactive in the default grid state, but once the user centers / zooms a tile the xterm accepts pointer events; activation routes to `openExternalUrl`.
- **Dedicated view** is fully interactive and also gets a `WebLinksAddon` with the custom handler (the tile preview omits WebLinksAddon because tiles don't scroll and a plain URL at rest is typically just visible text).

### `openExternalUrl` helper

```ts
export function openExternalUrl(url: string): void {
  const invoke = getTauriInvoke();
  if (invoke) {
    invoke('open_url', { url }).catch(() => {
      window.open(url, '_blank');  // fallback if command missing
    });
  } else {
    window.open(url, '_blank');
  }
}
```

The existing `bindExternalLinkHandler` (global `<a href>` click interceptor) is refactored to call this helper instead of inlining the same logic. The Tauri side of `open_url` (`src-tauri/src/lib.rs:633`) uses `tauri_plugin_opener` — already in the dependency list, no new Rust deps for this change.

## 28.4 Scope

**In scope for v1:**
- OSC 8 activation in drawer terminals.
- OSC 8 activation in dashboard tiles + dedicated view.
- Plain-URL activation (WebLinksAddon) rerouted through the same Tauri-safe helper — a latent Tauri bug that lived alongside the OSC 8 gap.
- `openExternalUrl` extracted as a shared helper so future escape-sequence features (OSC 7 CWD open-in-finder, OSC 133 Phase 3 ask-Claude) can reuse the Tauri-safe path.

**Out of scope:**
- **Non-http(s) protocols** (`file://`, `mailto:`, `ssh://`, etc.). xterm.js's `linkHandler` gets `allowNonHttpProtocols: boolean`; v1 leaves it at the default (false). Tools like `iterm2-imgcat` emit `file://` links that would open local files through the OS — useful, but deserves its own review because opening a file:// URL lands a user in an external application outside Hot Sheet's control. Follow-up if users request.
- **Hover tooltip showing the real URL.** VS Code displays a popover with the URL when hovering an OSC 8 link; we could do the same via `linkHandler.hover` + a DOM popover but it adds complexity and xterm already shows an underline, which is a reasonable "this is a link" affordance for v1.
- **Click-through safety prompt** for suspicious URLs. Deferred — trust the shell, trust the URL. If concerns arise, the server-side `open_url` command can add a prompt at that layer.

## 28.5 Testing

### Manual

Add to `docs/manual-test-plan.md` §12:

- In a drawer terminal, `ls -la --hyperlink=auto` (GNU coreutils 8.32+). File names render with an underline; clicking one opens the file in the OS default app (Finder on macOS).
- `gh pr list` (requires `gh` auth). PR numbers render with an underline. Clicking opens the PR page in a browser.
- In a git-with-delta setup, `git log -p | delta --side-by-side`. Commit hashes are OSC 8 links to the remote web view. Clicking opens the commit.
- Plain URL regression check: run `echo https://example.com`. The rendered URL is also clickable (WebLinksAddon path).
- Tauri regression check: same flows above in the desktop build — clicks succeed even though `window.open` would silently no-op. If a click does nothing, `openExternalUrl`'s Tauri branch is broken.

### Automated

Shipped under HS-7274: `e2e/terminal-drawer-osc8.spec.ts` + `e2e/fixtures/terminal-osc8.sh`. The fixture emits an OSC 8 hyperlink wrapping the visible text `CLICK-OSC8-LINK` with a known URL and then prints a bare plain URL on the next line. The spec installs a Tauri `invoke` stub before the bundle loads (stubbing `window.__TAURI__.core.invoke` to push calls onto `window.__invokeCalls` and return `undefined`), opens the drawer, activates the fixture terminal, clicks the hyperlinked text, and asserts a matching `{ cmd: 'open_url', args: { url: <OSC8_URL> } }` call landed in the capture array. It then clicks the plain URL on the next line and asserts a second `open_url` call with the plain URL — covering the regression case where xterm's default `WebLinksAddon` handler (`window.open`) silently no-ops in WKWebView; HS-7263's custom handler must route plain URLs through the same `openExternalUrl` helper.

## 28.6 Cross-references

- [22-terminal.md](22-terminal.md) — base terminal.
- [25-terminal-dashboard.md](25-terminal-dashboard.md) — dashboard xterms that also receive the linkHandler.
- CLAUDE.md §Tauri-unsafe-browser-APIs — why `window.open` isn't enough on its own.
- xterm.js API: `ITerminalOptions.linkHandler`, `@xterm/addon-web-links` v0.12 custom handler signature.
- Spec: [Gnome VTE OSC 8 proposal](https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda).
- `src-tauri/src/lib.rs:633` — `open_url` Tauri command implementation.
- **Tickets:** HS-7263 (this doc), HS-7274 (Playwright e2e + fixture, shipped — see §28.5).
