# 84. Custom command button "last run" hover (HS-8398)

> **Status:** Shipped (HS-8398, 2026-06-17). Hovering a custom command button shows when that command was last run.

Each custom command button (sidebar, §15 / §16) shows a **"Last run: …"** time on hover, so the user can tell at a glance how recently they invoked a command (e.g. "did I already run the build?").

## 84.1 Behavior
- **On hover** over any custom command button, the button's tooltip reads **`Last run: <relative time>`** (e.g. `Last run: 5 minutes ago`, `Last run: just now`, `Last run: 2 hours ago`) — or **`Not run yet`** if the command has never been run in the active project.
- The relative time is computed **on `mouseenter`** (not at render time), via `formatRelativeTime` (`src/client/timeFormat.ts`), so it's accurate every time the user hovers rather than frozen at the last list render.
- "Run" means actually invoking the command: a shell command's inline streaming run, a shell command launched in a new terminal (the §83.1 long-press or the "Launch in New Terminal" click), or a Claude command's channel trigger. **Long-pressing a Claude command to *make a ticket* (§83.2) is NOT a run** and doesn't update the time.

## 84.2 Data + persistence
- Last-run times are recorded at the **click/run site**, keyed by the same `${secret}::${commandKey(cmd)}` composite the running-state map uses (`runningKey` in `commandSidebar.tsx`). Recording at the run site — rather than deriving from the §14 command log — is what makes it work **uniformly for shell AND Claude** commands: the command log can't reliably attribute a row back to a specific button (Claude channel triggers log no button identity, shell rows match only by fuzzy command text).
- Storage is a single per-device `localStorage` JSON map (`hotsheet:command-last-run` → `{ compositeKey: isoTimestamp }`) in `src/client/commandRunTimes.ts` (`recordCommandRun` / `getCommandLastRun`). It survives reloads with **zero server cost** and tolerates corrupt/absent storage (reads as empty).
- Because the key includes the project secret and `commandKey` (`target::name::prompt`), the time is **per project** and resets if the command's name or prompt is edited (a different command identity).

## 84.3 Known limitations / follow-ups
- **Per-device only (v1).** `localStorage` is not synced across devices, so a command run on machine A shows "Not run yet" on machine B. A cross-device variant (a synced settings key, or deriving shell runs from the §14 command log) is a follow-up.
- **Native `title` tooltip.** Uses the browser's native tooltip (the codebase norm for buttons) — it has the usual hover delay and OS styling. A richer styled hover popover is a follow-up.

## Cross-references
- [15-shell-commands.md](15-shell-commands.md) / [16-command-groups.md](16-command-groups.md) — the command buttons.
- [83-command-button-long-press.md](83-command-button-long-press.md) — the long-press gestures that also count as runs (shell) or don't (Claude → ticket).
- [14-commands-log.md](14-commands-log.md) — the command-run history this deliberately does NOT derive from (attribution is unreliable).
