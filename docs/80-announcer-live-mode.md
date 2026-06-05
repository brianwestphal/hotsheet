# 80. Announcer Live Mode

**Status: Phase 2a (server generator) + 2b (client consumer) SHIPPED (HS-8750 +
HS-8767, 2026-06-05).** The producer + consumer of the §78.4.1 live-mode design
— near-live narration of work *as it happens*. The richer policies are deferred
follow-ups (see §80.6). This doc captures the shipped architecture; the full
design rationale lives in [78-announcer.md](78-announcer.md) §78.4.1.

## 80.1 Premise

Narration is slower than the work it describes (work lands in bursts of seconds;
spoken narration runs tens of seconds per entry). So live mode is **near-live
with a managed backlog**, not literal real-time: a producer watches the change
signal and coalesces bursts into coherent entries; a consumer drains them in
order. Entries are the same persisted `announcements` rows the after-the-fact
core (§78.11/§78.12) already uses, so the two modes share one pipeline.

## 80.2 Off unless listening (the spend gate)

Continuous background generation could silently spend the user's Anthropic key.
So generation runs for a project **only while a client holds a live "lease"**:

- `POST /api/announcer/live { enabled: true }` registers/renews a lease for the
  request's project (gated on opt-in + a resolvable key); `{ enabled: false }`
  drops it.
- A lease is a TTL (`LIVE_LEASE_MS`, 90 s). The client renews it on its poll
  cadence (2b). If a window closes / crashes / backgrounds and stops renewing,
  the lease expires and the generator stops for that project — no runaway spend.
- The lease registry (`src/announcer/liveGenerator.ts`: `registerLiveListener` /
  `unregisterLiveListener` / `getLiveProjects` / `isLive`) is the single
  authority on "who is live"; `getLiveProjects()` prunes expired leases in
  passing.

## 80.3 The generator loop

`src/announcer/liveGenerator.ts` runs while ≥1 project is live:

1. **Watch.** Subscribe to the global long-poll `change-version` (`addPollWaiter`
   in `src/routes/notify.ts`) — the same signal the UI polls. Re-arm after each
   wake; stop the loop when no project is live.
2. **Coalesce.** Each change `ping()`s a `CoalescingTrigger`
   (`src/announcer/coalescingTrigger.ts`): it fires after a **quiet window**
   (5 s) with no new change, but never later than a **max-wait cap** (25 s) from
   the first change of a burst — turning "edited 5 files, ran tests, wrote a
   note" into one entry instead of five stutters. (Pure + clock-injectable, so
   the timing is unit-tested with a fake clock.)
3. **Generate.** On fire, for **each live project** (the change-version is GLOBAL
   — wiring caveat a), re-query that project's signals since its own cursor and
   run the shared `generateAnnouncementsOnce` (`src/announcer/generate.ts`):
   collect → summarize (user's key + the §79/§78.12 selected key, cheapest model
   by default per HS-8764) → persist `announcements` → record usage (HS-8766) →
   `notifyMutation`. A failed pass logs and continues (never crashes the loop).

The generate core is **shared** with the manual `POST /api/announcer/generate`
route, so live and after-the-fact produce identical entries.

## 80.4 Command-log events on the fast signal (wiring caveat b)

Channel/shell command-log events (trigger / permission / done) were
fire-and-forget and did **not** ride the change-version, so the generator
couldn't see "Claude requested permission / triggered" promptly. `addLogEntry`
(`src/db/commandLog.ts`) now calls `notifyChange()` after every insert — the
spike's "cleaner fix" — so those events wake the generator (and the §12
command-log UI) on the same fast path as ticket mutations.

## 80.5 What shipped (2a) + tests

- `src/announcer/coalescingTrigger.ts` — debounce/coalesce timing (pure).
- `src/announcer/liveGenerator.ts` — lease registry + the change-version loop.
- `src/announcer/generate.ts` — `generateAnnouncementsOnce` (the shared
  collect→summarize→persist→record core, extracted from the route) +
  `isAnnouncerEnabled` / `effectiveSince`.
- `POST /api/announcer/live` (`src/routes/announcer.ts`) + typed caller
  `setAnnouncerLive` (`src/api/announcer.ts`).
- `addLogEntry` → `notifyChange()` wiring.
- Tests: `coalescingTrigger.test.ts` (quiet window, coalesce, max-wait cap,
  dispose — fake clock), `liveGenerator.test.ts` (lease register/expire/renew/
  unregister/multi-project), `routes/announcer.test.ts` (the `/live` opt-in gate
  + register/unregister). The change-version → ping → pass wiring is integration
  glue verified by the 2b e2e.

## 80.5.1 Client consumer (2b — HS-8767)

`src/client/announcerLive.ts` (`LiveSession`) is the consumer, wired into the PIP
(`announcerPip.tsx`):

- **Live toggle** in the PIP context bar. On → create a `LiveSession` for the
  current context's enabled projects, seed its dedup set with the entries already
  on screen (the catch-up reel from "Listen"), and start. Off → stop.
- **Lease renewal.** The session renews the lease (`setAnnouncerLive(true,
  secret)`) every 30 s (under the 90 s TTL). It **pauses renew + poll while the
  window is hidden** (`document.visibilityState`), so a backgrounded window lets
  its lease lapse → server generation stops → and resumes (with an immediate
  catch-up poll on `visibilitychange`) when refocused.
- **Tailing.** Every 3 s it fetches the queue (`getAnnouncerEntries(secret)` per
  live project), dedupes by `projectSecret:id` against what's already shown, and
  appends genuinely-new entries oldest-first via the new
  `AnnouncerPlayer.appendEntries` (resumes a finished reel into the new entry, or
  just extends the queue while playing).
- **Skip-catch-up.** A fast-forward control jumps the player to the newest entry
  (`AnnouncerPlayer.jumpToLast`) and advances the listened cursor for the live
  projects (drops the backlog).
- **"Still working" presence.** A presence line ("● working…" / "✓ idle") driven
  by the §12 channel busy state (`getProjectBusySecrets`), distinct from the
  entry being narrated.
- The context dropdown is disabled while live (live tails the current context).
  Closing/minimizing the PIP stops the session (drops the leases).

Tests: `client/announcerPlayer.test.ts` (`appendEntries` resume/extend +
`jumpToLast`), `client/announcerLive.test.ts` (lease renew, tail + dedup + sort,
stop drops lease, hidden-window pause, multi-project), `e2e/announcer.spec.ts`
(Live toggle → lease + presence + skip-to-live shown → a new generated entry is
tailed into the player → toggle off drops the lease).

## 80.6 Deferred follow-ups

Tracked as sibling tickets, all building on the 2a generator + 2b consumer:

- **Adaptive backlog compression** — raise summarization altitude when the
  unplayed backlog grows (HS-8768).
- **"Mark uninteresting" → learn-from-skips** — per-project dismissed-topics list
  injected into the generator prompt (HS-8769).
- **Cost/rate budget + spend & privacy disclosure** — per-minute/session call
  budget; live-mode-specific disclosure (HS-8770).
- **Hybrid generation: `hotsheet_announce` MCP tool** — curated, queue-preempting
  highlights layered on the derived baseline (HS-8771).
