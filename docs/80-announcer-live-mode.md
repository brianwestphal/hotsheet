# 80. Announcer Live Mode

**Status: Phase 2a (server generator) SHIPPED (HS-8750, 2026-06-05).** The
producer half of the §78.4.1 live-mode design — near-live narration of work *as
it happens*. The consumer (the PIP draining new entries, catch-up, the "still
working" presence line) is **HS-8767 (2b)**; the richer policies are deferred
follow-ups (see §80.6). This doc captures the shipped server architecture; the
full design rationale lives in [78-announcer.md](78-announcer.md) §78.4.1.

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

## 80.6 Deferred follow-ups

Tracked as sibling tickets, all building on this 2a generator:

- **2b — client consumer + catch-up + "still working" presence** (HS-8767).
- **Adaptive backlog compression** — raise summarization altitude when the
  unplayed backlog grows (HS-8768).
- **"Mark uninteresting" → learn-from-skips** — per-project dismissed-topics list
  injected into the generator prompt (HS-8769).
- **Cost/rate budget + spend & privacy disclosure** — per-minute/session call
  budget; live-mode-specific disclosure (HS-8770).
- **Hybrid generation: `hotsheet_announce` MCP tool** — curated, queue-preempting
  highlights layered on the derived baseline (HS-8771).
