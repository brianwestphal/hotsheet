# 38. Persisted terminal visibility (HS-7825)

## 38.1 Overview

The Show / Hide Terminals dialog (§25.10.6 / §36.6.5) lets users hide configured terminals from the global Terminal Dashboard (§25) and the per-project drawer terminal grid (§36). HS-7661 shipped this as **session-only** — every reload reset the hidden set so the user could declutter the current view without committing to a permanent setting. HS-7825 layers persistence on top: hidden state for **configured** terminals now survives across page reloads + app relaunches. Dynamic terminals (`dyn-*`) remain session-only because their lifetime ends with the PTY anyway.

## 38.2 Settings key

A new per-project file-settings key:

| Key | Type | Default | Notes |
|---|---|---|---|
| `hidden_terminals` | `string[]` | `[]` | Configured-terminal ids the user has hidden. Stored as a JSON array (added to `JSON_VALUE_KEYS` in `src/file-settings.ts`). |

The list contains terminal ids only — those are stable across renames, since `id` is preserved when a terminal row's `name` changes. Dynamic-terminal ids (`dyn-*` prefix) are filtered out at write time so a stale id from a vanished session never lingers in `settings.json`.

## 38.3 Hydration on app boot

`initPersistedHiddenTerminals(projects)` runs after `initProjectTabs()` resolves the registered-project list. For each project:

1. Fetch `/api/file-settings` (per-project secret) once.
2. Read the `hidden_terminals` field — accept either a native array or a stringified JSON array (legacy storage shape, see §22.10's `terminals` key handling).
3. Filter out any `dyn-*` ids defensively.
4. Call `hydratePersistedHiddenForProject(secret, ids)` on the in-memory map. The hydrate function fires the `subscribeToHiddenChanges` notify so any already-mounted dashboard / drawer-grid re-renders with the correct filter.

The persistence layer also stashes the canonical sorted-and-serialised payload per project so the change subscription doesn't immediately PATCH the same content back to disk on its first fire.

## 38.4 Write-back on toggle

`subscribeToHiddenChanges` fires after every `setTerminalHidden` / `unhideAllInProject` / `unhideAllEverywhere` call. The persistence layer schedules a per-project debounced PATCH (250 ms) that:

1. Reads the project's full hidden set from the in-memory map.
2. Computes the configured-only sorted subset via `computePersistedIds` — pure helper, sorted output stabilises serialised payload bytes so unchanged sets short-circuit the network call.
3. Compares the serialised payload against the last-persisted value. No-op when identical.
4. PATCHes `/api/file-settings` with `{ hidden_terminals: ids }` via `apiWithSecret(secret, …)`.

Errors are swallowed — a transient network failure leaves the toggle in memory; the next toggle re-schedules the write.

The per-project debounce means a "Show all" inside the dialog (which fires N `setTerminalHidden(false)` calls in a tight loop) collapses to a single PATCH per project.

## 38.5 Dynamic-terminal exclusion

Two filters keep `dyn-*` ids out of persistence:

- **Read.** `hydratePersistedHiddenForProject` runs every persisted id through `isConfiguredTerminalId` and silently drops dynamic ones (defense in depth — should never happen in practice since the write path also filters).
- **Write.** `computePersistedIds(allHidden)` walks the project's full hidden set and returns only the configured-id subset. Dynamic-terminal toggles still flow through the same in-memory map (so the dashboard's filter applies to them within the session) but never reach `settings.json`.

A user who hides a dynamic terminal and then closes it sees it disappear from the in-memory map automatically — `destroyTerminal` cleans up the registry entry, and the next dialog open computes fresh from the live `/terminal/list` response. No persistence-layer cleanup needed.

## 38.6 Implementation

- New module: `src/client/persistedHiddenTerminals.ts` — owns the debounced write timers + last-persisted cache + the change subscription. Exposes `initPersistedHiddenTerminals(projects)` for boot and `_flushForTests` / `_resetForTests` for the test harness.
- New helpers in `src/client/dashboardHiddenTerminals.ts`: `isConfiguredTerminalId(id)` (returns `!id.startsWith('dyn-')`) and `hydratePersistedHiddenForProject(secret, ids)`.
- `src/client/projectTabs.tsx` — calls `initPersistedHiddenTerminals` after the project-list fetch in both `initProjectTabs` (boot) and `refreshProjectTabs` (project added / removed).
- `src/file-settings.ts` — new entry in `JSON_VALUE_KEYS` so the array round-trips through `/file-settings` natively rather than as a stringified blob.

## 38.7 Out of scope (deferred)

- **Cleanup of stale ids on terminal deletion.** When the user removes a configured terminal from Settings → Terminal, its id might still appear in `hidden_terminals`. The list is harmless (the id resolves to nothing on next read) but accumulates over time. A follow-up ticket will hook into the terminals-settings save path to prune ids that no longer correspond to a configured terminal.
- **Dialog "Reset" affordance.** Today `unhideAllInProject` clears the persisted set as a side effect of clearing the in-memory state. An explicit "Reset to defaults" button in the Settings → Terminal panel would let a user restore visibility without opening the dialog. Tracked separately.
- **Cross-machine sync.** `hidden_terminals` is per-project, stored in `.hotsheet/settings.json` — same scope as every other per-project setting (§22.10, §37.5). Cross-machine sync of these settings is out of scope for v1; users who sync `.hotsheet/` via Dropbox / Drive get it implicitly.

## 38.8 Manual test plan

See [docs/manual-test-plan.md §13 (Show / Hide Terminals dialog)] for the existing flows. HS-7825 adds:

1. Hide a configured terminal → reload → it stays hidden.
2. Hide a configured terminal → quit and relaunch Hot Sheet → it stays hidden.
3. "Show All" inside the dialog → reload → every terminal shows.
4. Hide a dynamic terminal (`dyn-*`) → reload → it shows again (session-only behaviour preserved).
5. Multi-project: hide a terminal in project A, switch to project B, reload, switch back to A — A's filter is restored.

## 38.9 Cross-references

- §25.10 (Show / Hide Terminals dialog — global mode).
- §36.6.5 (Show / Hide Terminals dialog — per-project drawer-grid).
- §22.10 (per-project terminal config; ids the persistence layer keys against).

**Status:** Shipped (HS-7825). Cleanup-of-stale-ids + explicit Reset affordance are tracked in follow-up tickets.
