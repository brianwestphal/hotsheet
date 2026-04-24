# 29. OSC 7 shell CWD tracking (HS-7262)

## 29.1 Overview

OSC 7 is the de-facto standard escape shells use to report their current working directory to the terminal host:

```
printf '\x1b]7;file://hostname/Users/me/Documents/hotsheet\x07'
```

Starship, zsh's built-in `chpwd` hook, fish's `__fish_config_interactive`, VS Code's shell-integration rc files, iTerm2's integration, and Apple Terminal's `update_terminal_cwd` all emit this on every prompt. Before HS-7262 Hot Sheet ignored it — the bell scanner (HS-6766) specifically silenced the terminator so it wouldn't ring the bell, but the payload itself was discarded.

This feature wires OSC 7 up as a first-class signal: every terminal instance tracks its current CWD, displays it as a clickable chip in the in-pane toolbar, and opens the folder in the OS file manager when the chip is clicked.

## 29.2 Client parsing

`src/client/terminal.tsx` registers a handler during `mountXterm`:

```ts
term.parser.registerOscHandler(7, (payload) => {
  const parsed = parseOsc7Payload(payload);
  if (parsed !== null) {
    inst.runtimeCwd = parsed;
    updateCwdChip(inst);
  }
  return true;
});
```

The handler returns `true` to mark the sequence consumed (xterm.js no-ops if no handler matches, but signalling consumption is the convention). The parser helper lives in `src/client/terminalOsc7.ts` so it's unit-testable without xterm:

```ts
export function parseOsc7Payload(payload: string): string | null;
```

It validates the `file://` prefix, locates the first `/` after the optional host, and URL-decodes the path. Malformed percent encoding returns `null` rather than surfacing garbled text. Empty host (`file:///path`) is accepted — several shell scripts omit the hostname.

### Why not validate the hostname?

Remote sessions (SSH into a container, a dev VM, or a remote PTY multiplexer) push the remote hostname. The path may still resolve locally if the filesystem is mounted via SSHFS / NFS / VS Code Remote's file-sync; in practice, the server-side existence check on the reveal click is the right place to reject unresolvable paths. Over-validating at parse time would drop legitimate remote sessions.

## 29.3 Client UI — the CWD chip

A new element lives in every terminal pane header:

```html
<button class="terminal-cwd-chip" title="Open folder" style="display:none">
  <svg>…folder glyph…</svg>
  <span class="terminal-cwd-label"></span>
</button>
```

Hidden by default; `updateCwdChip` sets `display: ''` once `runtimeCwd` is populated and fills the label via `formatCwdLabel`. Label semantics:

- If `home` is known and the CWD is under it: tildify (`/Users/me/x` → `~/x`).
- If the display length exceeds **32 characters** and the path has ≥ 3 segments: collapse middle segments into `…/` and keep the last two (e.g. `~/…/to/target`).
- Otherwise: show as-is.

The full path is always in the `title` attribute so hover reveals the un-truncated value.

### Home-directory resolution

v1 does **not** know `$HOME` on the client, so tildification is disabled in the default path (`formatCwdLabel(cwd, null)`). The test coverage for the tildify branch is exhaustive anyway because a follow-up ticket (HS-7276) will push the resolved home via `/terminal/list` — at that point the chip becomes `~/…`-friendly without re-touching any of the display logic.

## 29.4 Opening the folder

Click handler on the chip:

```ts
void api('/terminal/open-cwd', { method: 'POST', body: { path: inst.runtimeCwd } });
```

Server endpoint in `src/routes/terminal.ts`:

```ts
POST /api/terminal/open-cwd
Body: { path: string }
```

Validation pipeline:

1. `path` must be a non-empty string (else 400).
2. `existsSync(path)` must be true (else 404).
3. `statSync(path).isDirectory()` must be true (else 400).
4. Dispatches to `openInFileManager(path)` (`src/open-in-file-manager.ts`) — existing cross-platform helper used by `POST /api/projects/:secret/reveal`.

### Why not client-side Tauri-direct?

Tauri's `open_url` command could take a `file://` URL directly. Two reasons we route through the server:

1. **Existence + directory validation.** The shell might have `cd`'d into a tmp dir that was then deleted; clicking a stale chip should 404 cleanly, not pop a confused Finder window.
2. **Cross-platform parity.** The server's `openInFileManager` already handles macOS / Windows / Linux differences. Reusing it keeps the behaviour consistent with the project-tab reveal flow.

No new privilege is granted vs. the shell running `open .` itself — the user has already authenticated with the secret.

## 29.5 Reset lifecycle

`runtimeCwd` resets to `null` in two places (mirroring `runtimeTitle`, §23.2):

1. **PTY restart** (`onPowerClick` → `/terminal/restart`) — the new process will push its own OSC 7 on the first prompt.
2. **Project switch** — `loadAndRenderTerminalTabs` tears down instances when the active project changes; fresh instances start with `runtimeCwd = null`.

Scrollback replay will include any OSC 7 the previous process pushed, so on reattach the most recent CWD is restored via xterm's parser replay — no special handling needed.

## 29.6 Scope

**In scope for v1:**
- Client OSC 7 parser + toolbar chip + open-folder click.
- Server validation endpoint reusing `openInFileManager`.
- Reset on restart and project switch.
- Unit tests for the parser and label formatter (16 tests in `terminalOsc7.test.ts`).
- Server-route tests for the open-cwd endpoint (5 tests in `api.test.ts`).

**Out of scope (explicit deferrals):**
- **Server-side CWD tracking** — registry.ts could parse OSC 7 from the PTY byte stream and expose via `/terminal/list`, letting the dashboard tiles show each terminal's CWD without mounting xterm. Deferred — not strictly needed for the toolbar chip, and the dashboard tile is already content-dense. Follow-up if asked.
- **Dashboard tile CWD badge** — blocked on the above.
- **Dashboard `+` button CWD inheritance** (HS-7262 description bullet 3) — the dashboard's per-project `+` creates a terminal with the project's default `cwd`. Passing the most-recently-OSC-7-reported CWD of another tile in the same project is a natural extension but requires cross-terminal state that doesn't exist today. Follow-up HS-7277.
- **Home-directory tildification** — parser already supports it, but the client doesn't know `$HOME`. Follow-up HS-7276 plumbs it via `/terminal/list`.
- **Non-local paths** (remote SSH sessions, SSHFS mounts). Parser accepts them; server validation rejects unresolvable paths with a 404. If there's demand for surfacing remote paths specifically (e.g. to open via a Remote-SSH workflow), that's a separate design.

## 29.7 Follow-up tickets

- **HS-7276** — expose `$HOME` on `/terminal/list` so the CWD chip can tildify.
- **HS-7277** — dashboard `+` button inherits the active tile's last-OSC-7 CWD.
- **HS-7278** — server-side OSC 7 tracking + dashboard tile CWD badge.

## 29.8 Manual test plan (add to `docs/manual-test-plan.md` §12)

- In a drawer terminal with zsh + starship, `cd ~/Documents`. The CWD chip populates with `~/Documents` (or `/Users/me/Documents` in v1 pre-HS-7276). Hover shows the full absolute path.
- Click the chip. The OS file manager opens at that folder (Finder on macOS, Explorer on Windows, xdg-open on Linux).
- `cd /tmp && rmdir /tmp/nonexistent 2>/dev/null; cd /`. Chip follows.
- Manually emit `printf '\e]7;file:///a/bogus/path\a'`. Chip updates. Click — receives 404, no file manager window opens.
- Restart the PTY (Stop → Start). Chip hides until the new shell pushes its first OSC 7.
- Switch to a different project. Each project's terminals have independent CWD tracking.

## 29.9 Cross-references

- [22-terminal.md](22-terminal.md) — base terminal.
- [23-terminal-titles-and-bell.md](23-terminal-titles-and-bell.md) — parallel feature for OSC 0/2 titles; the reset-on-restart pattern here mirrors that doc.
- [25-terminal-dashboard.md](25-terminal-dashboard.md) — potential consumer of server-side CWD state (deferred per §29.6).
- `src/client/terminalOsc7.ts` — pure parser + formatter helpers.
- `src/open-in-file-manager.ts` — cross-platform file manager dispatcher, reused from the project-reveal flow.
- xterm.js API: `term.parser.registerOscHandler(code, handler)`.
- **Tickets:** HS-7262 (this doc), HS-7276 / HS-7277 / HS-7278 (follow-ups).
