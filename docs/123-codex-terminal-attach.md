# 123 — Codex Terminal Attach (Driven-Thread Join)

> **Status: SHIPPED (HS-9394, 2026-07-23).** The user-facing payoff of the docs/121
> §121.6 daemon transport: a codex terminal Hot Sheet spawns joins the project's
> **driven** app-server thread instead of running an isolated local core — play-button
> work renders live in the terminal the user already thinks of as "their codex," and
> anything typed there shares the same conversation with the drive.
>
> Cross-refs: [121-codex-app-server-drive.md](121-codex-app-server-drive.md) (the
> daemon transport this rides, §121.6), [22-terminal.md](22-terminal.md) (terminal
> command resolution, §22.5), [113-multi-ai-tool-support.md](113-multi-ai-tool-support.md)
> (`ai_tool` routing, §113.3).

## 123.1 Problem

With the docs/121 drive, clicking play runs codex work in a persistent app-server
session — but the codex **terminal** Hot Sheet spawns (`{{aiCommand}}` → `codex`)
launched its own separate local core. The user's mental model is "that terminal is
my codex"; driven work happening in a session that terminal can't see reads as
"working invisibly in the background" (the HS-9380 report, again).

## 123.2 Mechanism (verified, codex-cli 0.145.0)

`codex resume <threadId> --remote unix://<sock>` attaches the TUI as a client of the
shared app-server daemon, subscribed to the driven thread: history renders, and
subsequent driven turns appear on the TUI screen **live with no user interaction**
(docs/121 §121.6 "TUI daemon attach — VERIFIED"). `--remote` is experimental codex
surface — like the rest of docs/121, behavior is pinned by probes against the
installed version and drift surfaces as visible launch errors (§123.6).

## 123.3 Command resolution

`pickAiCommand` (`src/terminals/resolveCommand.ts`), for `ai_tool=codex` with the
binary on PATH, consults **`codexTerminalAttachCommand(dataDir)`**
(`src/codexAppServer.ts`) and uses its command when non-null; otherwise the plain
`codex` binary launches exactly as before. This applies wherever `{{aiCommand}}` /
`{{claudeCommand}}` resolves for a codex project — the default AI terminal, custom
terminal templates, and worker-worktree terminals (each worktree's own `dataDir` →
its own driven thread, which is the correct per-worker semantics).

The attached form is emitted only when ALL hold:

1. **Drive enabled** — the §121.7 Experimental toggle (`codexAppServerEnabled`).
   Toggle off ⇒ plain `codex` (the drive surface is hidden anyway).
2. **Resumable rollout** — `<dataDir>/codex-app-server.json` carries `threadId` AND
   `rolloutPath` (HS-9394 addition, captured from the `thread.path` field of
   `thread/start`/`thread/resume` responses; pre-9394 files backfill on the next
   play), and the rollout file **exists on disk**. Existence is the exact gate:
   `codex resume` fails "no rollout found" until the thread's first turn persists.
3. **Daemon transport in play** — the live drive session (if any) runs on the
   `daemon` transport; with no live session, the daemon control socket exists (the
   next session will prefer it). A live **stdio** session vetoes the attach: a
   TUI-on-daemon resuming a rollout that a private stdio child is actively writing
   would be two cores fighting over one file.

The socket URL is single-quoted in the command (home directories can contain
spaces): `codex resume <id> --remote 'unix://<sock>'`.

## 123.4 Shared-thread interplay (live-verified)

Probed on 0.145.0 with a pty-driven TUI + a headless driver on the same thread:

- **Draft safety** — a driven turn arriving while the TUI holds typed-but-unsubmitted
  input renders above it; the draft is preserved.
- **Turn serialization** — a `turn/start` sent while another client's turn is in
  flight is **accepted and queued by codex**, running after the active turn ends.
  No rejection, no interleaving. (So the drive needs no thread-busy awareness —
  its queued turn simply waits server-side.)
- **Transcript parity** — TUI-typed turns stream to the drive's connection and land
  in the §121.6 Commands Log transcript; the drive's shared-thread guard (HS-9388)
  keeps them from driving Hot Sheet's busy/done lifecycle.
- **Approvals** route to the connection that started the turn: the TUI renders its
  own turns' approvals inline; driven turns' approvals go to the §47 overlay.

## 123.5 Fallback behavior

When any §123.3 condition fails, the terminal launches plain `codex` — today's
behavior, zero surprise. Notably:

- **Before the first driven turn** (fresh project, or thread reset per §121.5) there
  is no rollout ⇒ plain `codex`. The terminal does NOT pre-create or pre-attach a
  daemon session (a fresh `codex --remote` session would be daemon-attached but
  still not the driven thread — no watch value). See §123.7.
- **Daemon not running** at the moment a terminal resolves ⇒ plain `codex`. The
  synchronous resolver never starts the daemon itself; instead **HS-9396
  (SHIPPED)** pre-starts it ahead of need: `prestartCodexDaemonIfNeeded(dataDir)`
  (`codexAppServer.ts`) fires — fire-and-forget — at **project registration**
  (inside `eagerSpawnTerminals`), on an **`ai_tool` settings change**, and on
  **drive re-enable** (`POST /channel/codex-app-server`). It acts only when the
  attach is exactly one missing daemon away (drive on + `ai_tool=codex` +
  resumable rollout on disk + socket absent), calling
  `ensureCodexDaemonRunning()` (`codexDaemonTransport.ts` — socket check →
  `codex app-server daemon start` → poll; concurrent callers share one
  in-flight start). So after a machine restart, the daemon is typically up long
  before any terminal attaches. No thread warming is needed: a freshly started
  daemon loads a thread's rollout from disk on `thread/resume` (live-verified,
  0.145.0).
- **Already-open terminals** keep whatever they launched with until relaunched —
  the §123.8 reattach chip surfaces when a relaunch would join the driven thread.

## 123.8 Reattach affordance (SHIPPED, HS-9397)

Live codex terminals whose launch no longer matches the current attach resolution
get a **"↻ Rejoin codex"** pill in the terminal pane header (accent-outlined,
between the cwd chip and the copy-output button). It covers both drift
directions: a plain-`codex` terminal whose project has since gained a resumable
driven thread, and an attached terminal stranded on an old thread after a
§121.5 reset.

- **Detection** — `codexReattachAvailable` (`src/terminals/codexReattach.ts`):
  the session is alive with a recorded launch resolution (`resolvedCommand`,
  captured at spawn BEFORE the shell-history rewrite), the project currently
  emits an attach command, and a fresh `resolveTerminalCommand` (a) differs from
  the launch and (b) **contains** that attach command — (b) scopes the signal to
  codex-attach drift so unrelated template/config edits never light the chip.
- **Transport** — a `codexReattach` boolean per entry on `GET /terminal/list`
  (computed against one per-project attach resolution), seeded into the client
  on every list refresh (drawer open / project switch / settings save).
- **Action** — confirm dialog (relaunch kills the running TUI) → the standard
  `POST /terminal/restart`, which re-resolves the command on spawn — no special
  relaunch path. The chip clears optimistically; the next list refresh is
  authoritative.

## 123.6 Limitations

- A **thread reset** (§121.5 "New session") strands attached TUIs on the old thread;
  they keep working as ordinary codex sessions on the old conversation. Once the new
  thread has a rollout, the §123.8 chip offers the relaunch that attaches to it.
- If a future codex removes/changes `--remote`, the terminal shows codex's own
  launch error — visible, not silent; the drive toggle (off ⇒ plain `codex`)
  is the escape hatch.
- The attached TUI's session cwd is the **thread's** cwd (the project root),
  regardless of the terminal config's cwd setting.

## 123.7 Follow-ups

- **HS-9396 — SHIPPED** (daemon pre-start; folded into §123.5). Thread warming
  was investigated and found unnecessary.
- **HS-9397 — SHIPPED** (reattach affordance; §123.8).
