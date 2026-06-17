# 84. Custom command button "last run" hover (HS-8398)

> **Status:** Shipped (HS-8398, 2026-06-17). Hovering a custom command button shows when that command was last run.

Each custom command button (sidebar, §15 / §16) shows a **"Last run: …"** time on hover, so the user can tell at a glance how recently they invoked a command (e.g. "did I already run the build?").

## 84.1 Behavior
- **On hover** over any custom command button, a **styled tooltip** (HS-8847) appears beside the button showing the command **name**, its **command/prompt text**, and a **`Last run: <relative time>`** line (e.g. `Last run: 5 minutes ago`, `just now`, `2 hours ago`) — or **`Not run yet`** if the command has never been run in the active project.
- The relative time is computed **on `mouseenter`** (not at render time), via `formatRelativeTime` (`src/client/timeFormat.ts`), so it's accurate every time the user hovers rather than frozen at the last list render.
- "Run" means actually invoking the command: a shell command's inline streaming run, a shell command launched in a new terminal (the §83.1 long-press or the "Launch in New Terminal" click), or a Claude command's channel trigger. **Long-pressing a Claude command to *make a ticket* (§83.2) is NOT a run** and doesn't update the time.

### The tooltip (HS-8847)
A reused singleton `.command-tooltip` (`src/client/commandTooltip.tsx`) replaces the original native `title` (which had a ~1 s delay + OS styling). It is `position: fixed`, placed to the **right** of the hovered button (flips to the left near the viewport edge), `pointer-events: none` so it never steals hover, and is shown on `mouseenter` / hidden on `mouseleave` + on `pointerdown` (so it doesn't linger over a long-press action). `lastRunLine(iso)` builds the "Last run: …" / "Not run yet" string. Run count + last exit status were left out of v1 (they'd need fragile §14 command-log attribution).

## 84.2 Data + persistence
- Last-run times are recorded at the **click/run site**, keyed by the same `${secret}::${commandKey(cmd)}` composite the running-state map uses (`runningKey` in `commandSidebar.tsx`). Recording at the run site — rather than deriving from the §14 command log — is what makes it work **uniformly for shell AND Claude** commands: the command log can't reliably attribute a row back to a specific button (Claude channel triggers log no button identity, shell rows match only by fuzzy command text).
- Storage is a single per-device `localStorage` JSON map (`hotsheet:command-last-run` → `{ compositeKey: isoTimestamp }`) in `src/client/commandRunTimes.ts` (`recordCommandRun` / `getCommandLastRun`). It survives reloads with **zero server cost** and tolerates corrupt/absent storage (reads as empty).
- Because the key includes the project secret and `commandKey` (`target::name::prompt`), the time is **per project** and resets if the command's name or prompt is edited (a different command identity).

## 84.3 Known limitations / follow-ups
- **Per-device by design.** `localStorage` is per browser/client, so a command run in one client shows "Not run yet" in another. A cross-client variant (a server-side settings key) was considered and **deliberately declined** — the user confirmed cross-device sync isn't needed, and last-run is a lightweight per-device hint. (Cross-machine sync wouldn't be cleanly achievable anyway: each server's project data lives in a local, gitignored `.hotsheet/`.)
- **Run count / exit status not shown.** The §84.1 tooltip shows name + command + last-run only; surfacing run count or the last exit status would require §14 command-log attribution (unreliable for Claude). A further enrichment, if wanted, is a follow-up.

## Cross-references
- [15-shell-commands.md](15-shell-commands.md) / [16-command-groups.md](16-command-groups.md) — the command buttons.
- [83-command-button-long-press.md](83-command-button-long-press.md) — the long-press gestures that also count as runs (shell) or don't (Claude → ticket).
- [14-commands-log.md](14-commands-log.md) — the command-run history this deliberately does NOT derive from (attribution is unreliable).
