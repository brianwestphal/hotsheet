# 78. Announcer — A/V Narration of Project Work (Design Exploration)

**Status: design exploration, with Phase 1a (server generation backbone) SHIPPED
(HS-8745, 2026-06-05 — see §78.11) and Phase 1b (the after-the-fact audio client:
settings + transcript PIP + playback + TTS) SHIPPED (HS-8747, 2026-06-05 — see
§78.12).** The rest of this document is the design for
an opt-in audio/visual "announcer" that narrates the work being done on a
project — what changed, what the AI is doing now, what happened while you were
away. It captures the value proposition, an honest assessment of what's useful
vs. gimmicky, how the AI would generate the material, a phased build plan, a
data-model sketch, and the likely problems. It deliberately recommends a small,
high-value core first and flags the speculative parts. From HS-7294.

## 78.1 The idea (as requested)

- **Two modes.** *Live* — narrate changes as they happen / just happened, with
  a **catch-up** of anything not yet covered. *After-the-fact* — a summary of
  changes since the last time the feature was used.
- **Skipping.** Skip the whole catch-up phase (live); skip individual entries
  deemed uninteresting, and **learn from that** for future entries.
- **Three playback modes.** Audio-only, visual-only, audio-visual.
- **Playback controls.** Pause, previous entry, rewind 10s, next entry, skip
  10s, plus other helpful controls (speed, etc.).
- **PIP display** (visual / AV modes). A movable picture-in-picture above all
  chrome *except dialogs and popups*, with an expand button: default 240×180,
  4× to 960×720. Shows the spoken (or to-be-spoken) text with tasteful
  gradients / colors / rich-text emphasis, **plus** supporting visuals —
  critical code changes, before/after screenshots / close-ups, and
  AI-generated charts/diagrams when helpful.
- **Generation.** When enabled (per project), the AI generates "announcement
  notes" as it works on tickets; those drive the A/V experience.
- **Keys + TTS.** Collect users' AI API keys (the `~/Documents/glassbox`
  pattern). Default to OS/browser built-in TTS; optionally Google Cloud TTS (and
  others) for nicer playback. Store all keys in the OS keychain (§20).

## 78.2 Is it actually useful? (honest take)

**Where it earns its keep:**
- **The "I stepped away while Claude worked" briefing.** A 60-second spoken +
  visual digest of "here's what changed" beats scrolling a wall of completion
  notes. This is the strongest use case and maps cleanly to *after-the-fact*
  mode.
- **PMs / non-coders** who want a narrative of progress without reading diffs.
- **Accessibility** (audio narration) and **ambient awareness** (glance at the
  PIP while doing something else).
- **Marketing / sharing.** The project already has a marketing ticket type and
  a share feature (§17). A reconstructable "progress reel" is a natural
  shareable artifact — the announcer doubles as a demo generator.

**Where it risks being gimmicky (be candid):**
- For routine, fast-moving dev work, **audio is low-density** — a developer
  scans notes faster than they can listen. The win is the *digest/narrative*,
  not narrating every keystroke.
- **Rich generated visuals are the expensive, unreliable part.** Screenshots of
  "before/after a bug fix" require the AI to actually capture app state;
  charts/diagrams require generation that's often noisy. These should be **last**,
  not first.
- **Every announcement costs AI + TTS calls.** Without budgets and a clear
  "this uses your key/credits" disclosure, it surprises users.
- **Live mode has real engineering depth** — narration is fundamentally slower
  than the work it describes, so it can't be literal real-time; it needs a
  managed backlog, debounced/coalesced summarization, and good catch-up/skip.
  That depth is designed in full in **§78.4.1** rather than waved off.

**Conclusion:** the **after-the-fact digest** (built-in TTS + a simple transcript
PIP) is the simplest first *increment* — it's a strict subset of the live
pipeline (same entries / summarizer / playback, minus the tailing loop), so
building it first **de-risks** live mode rather than competing with it. **Live
mode is a first-class, near-term goal** (the user considers it as important as
after-the-fact) — fully designed in §78.4.1 and slated as the very next phase,
*not* deferred alongside the speculative generated visuals.

## 78.3 How the AI generates the material

Two sources, not mutually exclusive:

1. **Derived (recommended default).** Hot Sheet already captures rich work
   signals; an announcer can summarize them *without slowing the working AI*:
   - **Completion notes / ticket notes** (`tickets.notes`, `src/db/notes.ts`) —
     the AI already writes structured TL;DR + detail notes when it finishes
     tickets. These are the single best raw material.
   - **Command log** (§14, `src/db/commandLog.ts`) — channel triggers,
     permission requests, "done" events per project.
   - **Telemetry** (§67, `otel_*`) and **daily stats** (`stats_snapshots`,
     `src/db/stats.ts`) — "N tickets completed today," token/cost totals.
   - **Git status** (§48) — branch, dirty count, ahead/behind for a "shipped"
     framing.
   A separate **summarization pass** (run on demand when the user listens, or on
   a debounce in live mode) turns the raw signal range since the last cursor
   into a sequence of narrated *entries* (title + script + visual cues). This
   keeps generation **decoupled from the work** — no added latency/cost to the
   actual ticket execution.

2. **Curated (optional).** Give the working agent a new MCP tool, e.g.
   `hotsheet_announce({ title, highlight, visual? })`, to flag genuinely notable
   moments ("fixed a data-loss bug," "shipped the export") for the reel. More
   intentional, but adds in-task cost and needs prompt changes. **Hybrid:**
   default to derived summaries; let the agent emit curated highlights when it
   chooses.

The **narrative generation** (raw signals → spoken script + emphasis markup +
visual references) is where the user's **AI API key** is used (§78.6).

**Salient events — completions + feedback requests (HS-8820).** Two signal
classes are the ones a listener most wants to hear and are treated as
near-always-narrated, each with a concise summary of the note that was written:

- **Ticket completions** — `collectWorkSignals` emits a `marked completed.`
  line alongside the completion note, and the summarizer prompt
  (`src/announcer/summarize.ts`) instructs the model to give each completion its
  own entry summarizing what was actually done/fixed/decided (not a bare
  "finished a ticket"), never merging it into a vague group or omitting it.
- **Tickets waiting for feedback** — a ticket paused on a `FEEDBACK NEEDED:` /
  `IMMEDIATE FEEDBACK NEEDED:` note keeps `status = 'started'`, so it's otherwise
  indistinguishable from a routine note. `collectWorkSignals` flags the line
  `— WAITING FOR FEEDBACK]` (so the summarizer narrates the specific question)
  when the phrase is in the ticket's **current (last) note** AND the ticket is
  still **`started`** — mirroring `feedback-state.ts`'s "only the most recent
  note matters" + actionable-status rule (and the substring covers the
  `IMMEDIATE` superset). A resolved or already-answered feedback note narrates as
  a plain note.

Both classes are rated `medium`/`high` (never `low`), so they survive the
live-path `excludeLowImportance` drop (HS-8800) as well as the after-the-fact
digest. Only an explicit catch-up/backlog directive may compress multiple
completions together, and even then each one's outcome must stay identifiable.

## 78.4 Modes, entries, and playback

- **Entry = a discrete announcement**: `{ id, title, script (text + emphasis
  markup), visuals[], audioPath?, category, coversRange, dismissed }`. Entries
  are **persisted** (§78.7), so the reel is reconstructable and seekable — not
  just a transient stream.
- **After-the-fact:** on open, summarize everything since the per-project
  `announcer_last_listened_at`, enqueue entries, play sequentially; advance the
  cursor as entries are consumed.
- **Live:** near-live tailing of changes as they happen, with catch-up for the
  gap since the last cursor and a skip-catch-up jump to "now." This mode has
  enough depth to warrant its own treatment — see **§78.4.1**.
- **Controls:** play/pause · prev entry · next entry · rewind 10s · forward 10s
  · playback speed · skip entry. (10s seeks operate on the current entry's audio
  timeline; entry nav moves between entries.)
- **"Mark uninteresting":** dismiss an entry and record a lightweight signal
  (category + keywords) in a per-project preference; bias future summaries to
  omit similar material. Keep it simple (a dismissed-category/keyword list) to
  avoid overfitting; surface it as an editable list in settings.

> **Phase 2a + 2b SHIPPED (HS-8750 + HS-8767, 2026-06-05) — live mode is
> working end-to-end.** Server generator (producer loop, coalescing,
> off-unless-listening lease, command-log-on-the-fast-signal) + client consumer
> (PIP Live toggle, lease renewal, entry tailing, skip-catch-up, "still working"
> presence); see **[80-announcer-live-mode.md](80-announcer-live-mode.md)**. The
> richer policies (adaptive compression, learn-from-skips, cost budget, hybrid
> MCP tool) are tracked as follow-ups (HS-8768–8771).

### 78.4.1 Live mode — detailed design

**The core tension: narration is slower than the work.** Work lands in bursts
(the AI edits several files, runs tests, writes a completion note — all within
seconds); spoken narration runs at ~150 wpm (tens of seconds per entry). A
faithful "speak everything as it happens" mode would fall ever further behind.
So live mode is **near-live with a managed backlog**, not literal real-time —
and the whole design follows from accepting that.

**Producer / consumer over a persisted queue.** Two decoupled loops:
- *Producer (generation):* watches the project's change signals, batches them,
  and summarizes each batch into one or more `announcements` rows.
- *Consumer (playback):* drains unplayed entries in order via TTS + PIP,
  advancing a per-listener cursor.
Because entries are persisted (§78.7), the consumer can pause / rewind / run in
another window without losing the producer's progress, and the producer keeps
working while playback is paused.

**Generation pipeline (server-side):**
1. **Watch.** Reuse the existing change signal — the long-poll `change-version`
   bumps on any project mutation; the server-side generator subscribes to it (or
   polls the command log + `tickets.updated_at` / notes since its cursor). No
   new transport needed; the §46 WebSocket-push spike would only cut latency.
2. **Collect → order → dedup.** Pull every signal since the generator cursor
   (new/edited notes, status transitions, command-log events, git status), order
   by timestamp, and dedup overlaps — a completed ticket emits *both* a status
   change and a completion note; narrate it once.
3. **Debounce + coalesce.** Don't summarize on every bump. Wait for a quiet
   window (~3–8 s of no new changes) **or** a max-wait cap (~20–30 s) so a long
   burst still surfaces. Summarizing the *accumulated batch together* is exactly
   what turns "edited 5 files, ran tests, wrote a note" into one coherent entry
   instead of five stutters.
4. **Adaptive compression under backlog.** Track the playback backlog (unplayed
   entries / estimated speak-time). When it grows past a threshold, raise the
   summarization altitude — coalesce harder ("finished the export feature and
   its tests" rather than per-file detail) so narration can catch up instead of
   falling further behind.
5. **Generate.** Summarize the batch into entries (title + script + emphasis +
   optional visual refs) with the user's AI key (server-side, keychain). Persist
   `announcements` rows with `covers_from/covers_to`; advance the generator
   cursor.
6. **Play.** The client polls the announcements table since its playback cursor
   (same long-poll pattern) and drains new rows.

**Catch-up.** Enabling live mode (or returning) usually leaves a gap between the
playback cursor and "now." Catch-up summarizes that gap (identical to
after-the-fact) and plays it, then transitions into live tailing. **Skip
catch-up** jumps the playback cursor to the newest entry; the skipped span is
either dropped or collapsed into a single "while you were away: <gist>" line
(configurable). Either way the *generator* cursor still advances, so nothing is
double-counted.

**"Still working now" presence.** Live mode should convey "Claude is working on
HS-1234 right now" vs. a finished entry. The §12 channel already tracks
per-project busy / attention / feedback state (the project-tab dots). The PIP
shows a live status line from that signal ("● working…" / "✓ idle"), distinct
from the entry being narrated, so the listener knows whether more is coming.

**Derived vs. pushed (the latency trade-off):**
- *Derived / polled (default):* the generator polls signals — zero change to how
  the AI works, and it also covers *manual* user edits, not just AI work.
  Latency ≈ poll interval + debounce + summarization (a few seconds behind —
  fine for "just happened").
- *Pushed / curated:* the working agent calls a new `hotsheet_announce` MCP tool
  at milestones, jumping the queue with low latency and high intent — but only
  when an AI is doing the work, and it adds in-task cost + prompt cooperation.
- *Hybrid (recommended):* derived baseline for coverage; agent-pushed highlights
  that pre-empt the queue for genuinely notable moments.

**Cost & rate control (live mode's sharp edge).** Continuous generation while the
AI works could fire many summarization calls. Controls: the debounce/coalesce
above (one call per batch, not per change); a per-minute / per-session **call
budget** that, when hit, widens the debounce window and compresses harder;
**pause generation when no one is listening / the window is backgrounded**
(resume → catch-up); and an explicit spend + privacy disclosure (work — code,
notes — leaves the machine to the AI/TTS provider; opt-in per project, vs.
today's local-only §1.3).

**Skipping + learning, live.** Skip drops the current entry and advances. "Mark
uninteresting" appends to the per-project dismissed-topics list **and** is
injected into the generator's prompt going forward ("the listener isn't
interested in test-run / lint announcements"), so future batches omit similar
material — which *also* shrinks the backlog, not just the annoyance.

**Failure / edge handling.** AI API error → generation stalls gracefully (PIP:
"narration paused — provider error"; playback drains what's queued). TTS failure
→ fall back (cloud → browser, or transcript-only). Server restart / poll gap →
the generator cursor + catch-up fill the hole on the next tick. Multiple windows
→ a shared `announcements` store with a **per-window playback cursor** (each
listener keeps their own position); `announcer_last_listened_at` records the
high-water mark.

**Why it's buildable on what exists.** The long-poll change-version (live
trigger), the command log + notes + status timestamps (signal sources), the
keychain (AI key), and persisted entries (decoupling) are all present or trivial
to add. Live mode is mostly the **generator loop + debounce/backlog policy** on
top of the shared after-the-fact core — which is why building after-the-fact
first directly de-risks it.

**Phase 0 spike findings (HS-8744 — code-grounded).** The live trigger is even
better than assumed, with three concrete wiring caveats Phase 2 must handle:
- **Latency is near-instant.** `notifyMutation()` (`src/routes/notify.ts`) bumps
  the change-version *synchronously on the write path* and wakes the `GET
  /api/poll` long-poll (`src/routes/dashboard.ts`, 30 s hold) in the same tick;
  the client re-polls 100 ms after each cycle. Change → observable is ~20–300 ms
  locally. So the debounce/coalesce window (§ step 3) is purely for *coherence*
  (batching a burst into one entry), not to compensate for a slow signal.
- **The change-version is GLOBAL, not per-project** (one counter in `notify.ts`
  for all projects). A mutation in any project wakes every poll with the same
  number. Fine for the announcer — but the generator can't tell *which* project
  changed from the version alone; it re-queries each watched project's signals
  since that project's cursor.
- **Command-log channel events do NOT ride the change-version.** `addLogEntry`
  (trigger / permission_request) is fire-and-forget; only `/channel/done` also
  calls `notifyChange()`. The command log is polled separately (~5 s, drawer-
  open). So "Claude requested permission / triggered" is **not** on the fast
  signal. Phase 2 options: (a) poll the command log on the generator's own
  interval, or (b) wire `notifyChange()` into `addLogEntry` so channel events
  ride the fast path too. **(b) is the cleaner fix** and benefits the §12 UI
  generally.
- **No `created_at >= since` query helpers exist yet** — `getLogEntries` /
  ticket queries are `limit`/`offset` only. Phase 1 adds a `since` filter to
  `getLogEntries` and a notes/status-since query (small, in `src/db/`).

## 78.5 The PIP display (visual / AV)

- Movable, **draggable**, **resizable** (expand toggle: 240×180 ↔ 960×720),
  persisted position/size per project. Sits above normal chrome but **below**
  dialogs/popups/permission overlays — pick a z-index beneath the §47 permission
  popup and the feedback dialog.
- **Model on existing overlays:** the reader-mode overlay (§49,
  `readerOverlay.tsx`) for fixed-position markdown rendering, and the
  permission popup (§47, `permissionDialogShell.tsx`) for a draggable,
  minimizable, non-modal floating panel. The announcer PIP is essentially a
  persistent, draggable, resizable variant.
- **Resizable PIP (shipped, HS-8749).** An expand/collapse toggle in the PIP
  header (`.announcer-pip-expand`) widens the panel for long scripts
  (`.announcer-pip.is-expanded`, ~520 px + a taller scrollable body); the state
  is remembered in `localStorage` (`hotsheet:announcer-pip-expanded`) and
  re-applied on open. Toggling re-clamps the position so a grown panel never
  spills off-screen. (The original 240×180 ↔ 960×720 sketch was simplified to a
  single roomier preset; per-project sizing wasn't worth the storage.)
- **Content tiers (build in this order):**
  1. **Text + emphasis (shipped, HS-8749).** The spoken script with tasteful
     gradient emphasis on the key phrase(s). The summarizer returns an optional
     `emphasis` string array per entry — each a *verbatim* substring of the
     `script` — persisted in `announcements.emphasis` (JSON, `EmphasisArraySchema`)
     and rendered by `src/client/announcerEmphasis.tsx` (`renderScript` wraps
     each phrase in `<strong class="announcer-em">`; the spoken text is
     unchanged). Falls back to plain text when there's no emphasis.
  2. **Code diffs (shipped, HS-8772).** Reuses the §47 permission-preview diff
     renderer (`src/client/editDiffPreview.tsx::renderEditDiffPreview`, which is
     self-contained + Tauri-safe). An entry references a diff via the new
     `announcements.visuals` JSON column (§78.7; `VisualsArraySchema`, a
     discriminated union whose only variant today is `{ type: 'diff', oldStr,
     newStr, filePath?, replaceAll? }`). The producer is the **curated**
     `hotsheet_announce` MCP tool, which gained an optional `diff` ({oldStr,
     newStr, filePath?}) so the working agent — which knows exactly what it
     changed — can attach a focused before/after (CHANNEL_VERSION → 11). The PIP
     renders it in a `.announcer-pip-visual` pane below the script, shown only
     when the current entry carries a diff (the expanded panel from HS-8749 gives
     it room). The derived summarizer path produces no diffs (an AI summary of N
     signals can't be cleanly attributed to one commit-level diff) — that's why
     the curated path is the source of truth.
  3. **Charts / before-after screenshots / diagrams** — Phase 3, expensive and
     unreliable; defer until the core proves out.

## 78.6 Secrets — AI + TTS API keys

- Reuse **`src/keychain.ts`** (§20): `keychainGet/Set/Delete(pluginId, key)`,
  `isKeychainAvailable()`. **As of HS-8751 the announcer no longer stores its own
  key** — keys live in the global registry (§79, `docs/79-api-keys.md`, keychain
  plugin id `keys`) and the project selects one. The original design below
  (`pluginId: 'announcer'`) was the Phase-1b implementation, superseded by §79.
- Mirror the **glassbox 3-tier resolution** (`~/Documents/glassbox/src/ai/`):
  **env var → keychain → config file**, with a `{ key, source }` result so the
  UI can show where a key came from. Apply the same chain to both the **AI
  summarization key** (Anthropic/OpenAI) and each **TTS provider key**.
- **TTS providers (revised by the HS-8744 spike):**
  - **Desktop (Tauri) primary: a `tts_speak` Tauri command** wrapping macOS
    `say` (confirmed present at `/usr/bin/say` with a full voice list) — model
    it on the existing `#[tauri::command]` surface in `src-tauri/src/lib.rs`.
    This is rock-solid and **sidesteps the WKWebView risk**: rather than depend
    on WKWebView `speechSynthesis`, the desktop build uses the OS voice directly.
    Linux/Windows get their native equivalents later; cloud TTS is the
    cross-platform fallback. *(WKWebView `speechSynthesis` has since been
    **empirically verified** to produce audio in the Tauri macOS build — HS-8811,
    confirmed 2026-06-16 — so the browser path is a viable secondary on desktop,
    but `say`-via-Tauri remains the primary regardless. See the check below.)*
  - **Browser build: Web Speech API** (`speechSynthesis`) — zero config/cost,
    works in Chromium/Safari. Feature-detect at runtime; if `getTauriInvoke()`
    is non-null prefer the `tts_speak` command, else use `speechSynthesis`.
  - **Optional: Google Cloud TTS** (and others) — server-side synth call
    returns audio bytes the client plays; key from the keychain. Higher quality,
    costs money, needs the disclosure in §78.8. Also the cross-platform fallback
    when no native voice path is available.
  - **WKWebView `speechSynthesis` empirical check (HS-8811 — VERIFIED
    2026-06-16).** Ran a voice-enumeration + spoken-utterance snippet in the
    Tauri macOS desktop app's WebKit dev console: `'speechSynthesis' in window`
    is true, `getVoices()` returned the full macOS voice list (Samantha [default],
    Albert, Fred, …), the utterance fired `onstart` → `onend` with **no
    `onerror`**, and **audio was audibly produced**. Verdict: the browser
    `speechSynthesis` path is a viable *secondary* on the macOS desktop build —
    but `say`-via-`tts_speak` stays the primary (no behavior change; this just
    retires the last open WKWebView-reliability question from the HS-8744 spike).
    Reproduce via the console snippet recorded on HS-8811 (voice list + a test
    `SpeechSynthesisUtterance` with `onstart`/`onend`/`onerror` logging).
- **Settings UI:** a dedicated "Announcer" settings tab (HS-8777 — shipped as
  its own tab; was briefly a section under Experimental) with: per-project enable toggle, AI provider + key,
  TTS provider + key, default playback mode, and the "uninteresting" dismiss
  list. The `secret: true` input convention already renders password fields.

## 78.7 Data-model sketch

- **`announcements`** (per-project DB table): `id`, `created_at`,
  `covers_from` / `covers_to` (the signal range summarized), `title`,
  `script`, `emphasis` (JSON string array — HS-8749 tier-1, shipped),
  `visuals` (JSON array of visual specs — HS-8772 tier-2, shipped; today only
  `{ type: 'diff', … }`, extensible to image paths / chart specs), `position`,
  `dismissed` (bool), `listened_at` (TIMESTAMPTZ, NULL = never heard — HS-8803,
  shipped). `audio_path` (cached TTS blob), `category`, `tags` remain
  the Phase-3/4 sketch. Persisting entries makes the reel seekable + replayable
  + shareable.
  - **Listened tracking + 1h grace clear (HS-8803).** The PIP stamps
    `listened_at = now()` when the user lands on an entry; `getActiveAnnouncements`
    then **excludes** any entry heard more than a 1-hour grace window ago, so heard
    pages clear an hour after listening instead of piling up (a user reported a
    63-entry reel). Never-heard (`listened_at IS NULL`) and recently-heard entries
    are kept. Landing on an entry marks the **whole consumed prefix** heard, not
    just that entry: every **earlier** entry (by playback order `(position, id)`)
    is stamped `now()` too, so skipping ahead — or jumping to the live
    announcement — clears the backlog the user leapt over instead of leaving it
    piled up (HS-8803 follow-up). Landing also resets the grace timer for every
    **later already-heard** entry (so scrubbing back doesn't expire the pages ahead
    of you); never-heard later entries are left NULL. Because the reel can span
    projects in "All Projects" mode, the client marks one representative entry per
    project for the prefix (`reelPrefixListenTargets`), and the server stamps each
    project's whole prefix from there. A fresh "Listen" open starts
    on the first non-listened entry (`firstUnlistenedIndex`), falling back to the
    newest when all are already heard. A one-time, sentinel-guarded backfill marks
    the pre-`announcer_last_listened_at` backlog as already-heard so existing reels
    clear on first read after upgrade.
- **Per-project settings:** `announcer_enabled`, `announcer_last_listened_at`,
  `announcer_ai_provider`, `announcer_tts_provider`, `announcer_default_mode`,
  `announcer_dismissed_topics` (the learn-from-skips list), PIP `position/size`.
  Store via the existing file-settings / settings-table pattern; keys in the
  keychain.
- Cached TTS audio belongs with attachments-style on-disk storage under
  `.hotsheet/` (and should be covered by cleanup / not synced to git).

## 78.8 Likely problems / open questions

- **WKWebView `speechSynthesis` reliability** — *was* the single biggest risk to
  the "free default." **Resolved (HS-8811, 2026-06-16):** empirically verified to
  enumerate voices + produce audio in the Tauri macOS WKWebView (`onstart`/`onend`,
  no `onerror`). `say`-via-`tts_speak` is the desktop primary either way; the
  browser path is a confirmed-working secondary. See §78.6.
- **Cost & disclosure** — summarization + cloud TTS spend the user's
  credits/keys. Need per-session budgets, throttles, and an explicit, up-front
  "this sends your work to <provider> and uses your key" opt-in, **per project**
  (privacy: code + notes leave the machine — today everything is local, §1.3).
- **Live-mode latency & ordering** — debounce, dedup, and stable ordering of
  entries; never talk over a burst of changes.
- **Visual generation quality/cost** — screenshots and diagrams are the hardest,
  least reliable part; start with text + code diffs only.
- **Interrupt/skip must be instant** — queue management and pre-fetching audio
  so prev/next/skip feel immediate.
- **"Uninteresting" feedback** — keep the model simple (topic/keyword dismiss
  list) and user-editable; avoid a hidden ML loop that surprises people.
- **Multi-project** — entries are per project; a cross-project "what happened
  everywhere" digest is a possible later add (mirrors §70 cross-project stats).
- **Determinism** — persist entries so a reel can be replayed/seeked/shared
  identically, rather than re-summarizing each time.

## 78.9 Recommended phasing

Live mode is elevated to Phase 2 (was Phase 3) at the user's request — it's the
co-headline feature, so it follows immediately after the shared core rather than
being deferred with the speculative visuals.

- **Phase 0 — spike (HS-8744 — DONE, verdict: GO).** Findings folded into
  §78.4.1 + §78.6: (a) **TTS** → ship a `tts_speak` Tauri command over macOS
  `say` (confirmed available) as the desktop primary, `speechSynthesis` in the
  browser; the unverified WKWebView question no longer gates anything. (b)
  **Derived vs. curated** → derived is sufficient for the MVP (the structured
  completion notes are high-quality summarizer input); curated `hotsheet_announce`
  is an optional Phase 2 enhancement. (c) **Live cadence** → the change→observe
  latency is ~20–300 ms (near-instant), so the debounce window is for coherence
  only; three Phase-1/2 wiring tasks identified (per-project re-query off the
  global version, the command-log-not-on-change-version signal, and adding
  `created_at >= since` query helpers). Two things still need hands-on
  confirmation but don't block: the empirical WKWebView `speechSynthesis` check
  (**done — HS-8811, verified audible in the macOS build 2026-06-16; see §78.6**)
  and a real AI-key summarization quality pass.
- **Phase 1a — server generation backbone (HS-8745, SHIPPED 2026-06-05).** The
  derived-summarization engine + API, verified end-to-end with a real key. See
  §78.11 for the implementation. Remaining for Phase 1b: the client (settings
  section, transcript PIP, playback controls, TTS abstraction + the `tts_speak`
  Tauri command).
- **Phase 1 — after-the-fact core (SHIPPED 2026-06-05 — HS-8745 §78.11 server +
  HS-8747 §78.12 client).** After-the-fact, **audio-only**, built-in TTS, opt-in
  per project. Persisted `announcements` + `announcer_last_listened_at`. Simple
  transcript PIP (text). Core playback controls (play/pause, prev, next, skip).
  Keychain-backed AI key + settings section. This is the shared pipeline live
  mode builds on. *Deferred to follow-ups:* the 10s audio-timeline seeks (need
  cached audio — a Phase 3 cloud-TTS artifact), text emphasis markup, and a
  draggable/resizable PIP.
- **Phase 2 — live mode.** The §78.4.1 producer/consumer loop: server-side
  generator on the long-poll `change-version`, debounce + coalesce, adaptive
  backlog compression, catch-up + skip-catch-up, the "still working" presence
  line, and "mark uninteresting" → learn-from-skips. Hybrid generation
  (derived baseline + optional `hotsheet_announce` MCP highlights). Cost/rate
  budget + the privacy/spend disclosure.
- **Phase 3 — A/V visuals.** Visual-only + audio-visual PIP (draggable/resizable,
  rich emphasis, **code-diff** visuals reusing §47 diff rendering). Google Cloud
  TTS option (keychain).
- **Phase 4 — rich visuals + share.** AI-generated charts/diagrams/screenshots;
  export the reel via the §17 share flow for marketing.

## 78.10 Reuse map (where to build on)

| Need | Existing | File |
|---|---|---|
| Secret storage | §20 keychain | `src/keychain.ts` |
| AI-key 3-tier pattern | glassbox | `~/Documents/glassbox/src/ai/` |
| Raw material — notes | ticket notes | `src/db/notes.ts` (`tickets.notes`) |
| Raw material — events | §14 command log | `src/db/commandLog.ts` |
| Raw material — stats/cost | §67 telemetry, daily stats | `src/db/stats.ts`, `otel_*` |
| Floating, draggable, non-modal panel | §47 permission popup | `permissionDialogShell.tsx` |
| Fixed-position markdown overlay | §49 reader mode | `readerOverlay.tsx` |
| Code-diff visual | §47 permission diff preview | permission preview rendering |
| Per-project opt-in toggle + settings UI | settings / experimental | `experimentalSettings.tsx`, `src/file-settings.ts` |
| Share the reel | §17 share | share flow |

Follow-up tickets track the phased build: Phase 0 spike (incl. live-cadence
validation), Phase 1 after-the-fact core, and Phase 2 live mode.

## 78.11 Phase 1a implementation — server generation backbone (HS-8745, shipped)

The derived-summarization engine + REST API, built and **verified end-to-end
with a real Anthropic key** (the spike's open "are derived summaries good
enough?" → yes; a real run turned this session's completion notes into clean,
spoken-style entries in ~7 s). Audio-only client (PIP + playback + TTS) is
Phase 1b.

**Pipeline (server-side, derived, decoupled from the working agent):**
- `src/announcer/collectSignals.ts` — `collectWorkSignals(since)` gathers the
  signals since the cursor (completion/ticket notes via `parseNotes`, ticket
  completions, §14 command-log events through the new `getLogEntries({ since })`
  filter), de-dups, orders chronologically, and renders a plain-text block. No
  AI here, so it's fully unit-tested. Attachments / raw code are deliberately
  excluded (privacy; the notes are already summaries). **The block is bounded to
  a safe input-token budget** (`capMaterial`, `MAX_INPUT_TOKENS = 600_000`,
  ~3 chars/token) — keeping the most recent signals behind an elision marker and
  dropping older ones — so a long-history project can't blow the Anthropic 1M
  input-token limit (HS-8752: a from-scratch generate once assembled ~1.67M
  tokens and the whole "Listen" failed with "prompt is too long"). This is the
  static form of §78.4.1's "adaptive compression under backlog".
- `src/announcer/summarize.ts` — `summarizeWork(material, { apiKey, model? })`
  calls the Anthropic Messages API (official `@anthropic-ai/sdk`) with a
  structured-output JSON schema → guaranteed-valid `{ title, script }[]`,
  validated with zod. Default model `ANNOUNCER_MODEL = 'claude-opus-4-8'`
  (per the Anthropic API skill; overridable per call so a user can switch to a
  cheaper model like `claude-haiku-4-5`).
- `src/announcer/key.ts` — `resolveAnnouncerKey()` (env `ANTHROPIC_API_KEY` →
  keychain `announcer/anthropic_api_key`, glassbox-style) + `setAnnouncerKey`.

**Persistence + settings.**
- `announcements` per-project table (migration in `connection.ts`):
  `id, created_at, covers_from, covers_to, title, script, position, dismissed`.
  CRUD in `src/db/announcer.ts` (`insertAnnouncements` appends positions;
  `getActiveAnnouncements`; `dismissAnnouncement`; `clearAnnouncements`;
  `getLatestCoversTo` — normalized to ISO so the `effectiveSince` cursor compare
  is correct).
- Per-project settings (DB/file settings): `announcer_enabled`,
  `announcer_last_listened_at` (the listen cursor — advanced on **listen**, not
  generate). The AI key lives in the OS keychain (§20), not settings.

**API** (`src/routes/announcer.ts`, mounted at `/api`; typed wire schemas +
callers in `src/api/announcer.ts`):
`GET /api/announcer/status`, `POST /generate` (opt-in + key gated; `since`
defaults to max(cursor, latest covers_to) so a re-generate doesn't re-cover
unheard work), `GET /entries`, `POST /cursor`, `POST /enabled`, `PUT /key`,
`POST /dismiss/:id`, `POST /clear`.

**Tests.** `db/announcer.test.ts`, `announcer/collectSignals.test.ts` (since
filtering + chronological order against a temp DB), `announcer/summarize.test.ts`
(SDK mocked — key/model/schema wiring + malformed-response handling),
`api/announcer.test.ts` (caller URLs + schemas), `routes/announcer.test.ts`
(opt-in gate, generate→persist with the summarizer mocked, cursor). 27 tests.
A new `@anthropic-ai/sdk` dependency was added (server-side).

## 78.12 Phase 1b implementation — after-the-fact audio client (HS-8747, shipped)

The user-facing half of the after-the-fact MVP, built on the Phase 1a typed
callers (`src/api/announcer.ts`). Audio-only, opt-in per project, transcript
PIP. The real audio (`say` voice / browser `speechSynthesis`) and the Tauri
path need a desktop/manual pass — see the manual test plan — but the wiring,
playback state machine, and UI are automated.

**TTS abstraction (`src/client/tts.ts`).** One `SpeechEngine` interface, two
backends chosen at runtime per the HS-8744 spike: **Tauri desktop primary** —
the `tts_speak` / `tts_stop` Rust commands (`src-tauri/src/lib.rs`) drive the
OS voice (`say` on macOS; `spd-say --wait` on Linux; PowerShell `System.Speech`
on Windows), sidestepping the unverified WKWebView `speechSynthesis` risk;
**browser** — the Web Speech API (`speechSynthesis`), the only backend that can
pause/resume mid-utterance. `speak()` resolves a discriminated `'ended' |
'cancelled' | 'error'` so the player can tell a natural finish (auto-advance)
from an interruption. The engine is injectable, so the state machine is
unit-tested with a fake.

**Playback state machine (`src/client/announcerPlayer.ts`).** DOM-free,
unit-tested. Sequential narration with play/pause, prev/next entry, and skip
(remove + dismiss). A monotonic `utteranceToken` guards against a stale
`speak()` resolution landing after an interrupting action. Pause is true
mid-utterance pause on the browser backend; on the OS-voice backend (no native
pause) it stops and re-speaks the entry from the start on resume.

**Transcript PIP (`src/client/announcerPip.tsx`).** A non-modal floating panel
(z-index 2200 — above chrome, below the reader overlay 2400, the feedback dialog
2500, and the permission popup, so a dialog/prompt is never obscured). Shows the
entry title + spoken script + position (N/M) and the playback controls.
**HS-8756 — draggable + anchored:** opens anchored just beneath the Listen
button (pure geometry in `announcerPipPosition.ts`, unit-tested), is dragged by
its header, and remembers its position in `localStorage`
(`hotsheet:announcer-pip-pos`). **HS-8757 — minimize:** a minimize button (and
Escape) hides the panel back into the Listen button *without stopping playback*;
the button then **glows** (the project-tab pending-permission pulse,
`.announcer-listen-btn.is-active`) and a second click restores the panel
(`announcer.tsx` routes the click to `restore()` when a session is live rather
than regenerating). **HS-8788 — the Listen button toggles an open session:**
clicking it while the panel is *visible* **minimizes** it (and a click while
minimized restores) — playback continues either way; it only generates+opens a
fresh reel when no session is live. Resizable, code-diff visuals, the 10s audio-timeline seeks,
and playback-speed are later phases (see the follow-up tickets).

**HS-8827 — header/footer rework.** The header **X** now *hides* the panel
(the former minimize behavior) instead of closing it; the dedicated minimize
button is gone, and an explicit **Stop** button (`.announcer-pip-stop`, filled
square) ends the session entirely (the former close path — `dispose()` +
`clearAnnouncerSession()` + `onClose` cursor advance). **HS-8832 — the header
control order is Stop, Expand, Hide (X)** (`.announcer-pip-stop` sits before
`.announcer-pip-expand`). The footer meta row gains
a **per-announcement timestamp** (`.announcer-pip-timestamp`, `timeAgo(created_at)`
relative text + absolute on hover) and a **Clear All** button
(`.announcer-pip-clear`, trash icon) that — behind a confirm — permanently wipes
every announcement in the current view via `POST /announcer/clear` per project
(`clearTargetSecrets(context, projects)`: all offered projects in "All Projects"
mode, else the selected one) and leaves the panel open showing a "No
announcements." empty state. The idle/working **presence** line and the
"Speaking via system/browser voice" **hint** are removed (only the actionable
"no voice available — transcript only" note survives). The **context dropdown is
now switchable while Live** — switching stops live on the old context, swaps the
reel, and resumes live tailing on the new context's secrets (pre-fix the dropdown
was disabled in live mode).

**Busy feedback (HS-8753 → HS-8883).** Clicking Listen shows a button spinner
(`.is-busy`) while the overview + existing reel load. **HS-8883 — the PIP now
opens *immediately*** with whatever entries already exist (often none on a first
run) rather than waiting for the generation round-trip behind a toast. Generation
runs in the **background** inside the PIP via the `generate` callback
(`OpenPipOptions.generate` → `generateAnnouncements` + reload), and the new
entries are merged in (`newReelEntries` dedups on owning-project + id, then
`player.appendEntries` — which starts playback if the reel had been empty). An
**empty open is no longer a dead-end toast**: the panel opens showing an in-panel
placeholder (`PREPARING_MESSAGE` while generation runs, then `NOTHING_YET_MESSAGE`
if nothing landed), so the user can still **switch focus projects via the context
dropdown** while waiting. Switching to a context with no entries renders the same
placeholder instead of leaving the prior entry's text stale.

**Cross-project / context dropdown (HS-8762 + HS-8758).** The announcer is no
longer strictly per-project. A new `GET /api/announcer/overview` enumerates every
project with the announcer enabled (reading each project's enabled / key /
entry-count in its own DB context via `runWithDataDir`, mirroring the §70
cross-project stats enumeration) and returns the active project's secret. The
PIP gains a **context dropdown**: "All Projects" + each enabled project.
- **"All Projects"** aggregates each enabled project's **already-generated**
  entries (no fresh generation — by design, HS-8762), interleaved
  chronologically, each entry showing a **project-name chip**. Because that chip
  isn't audible, the **spoken narration also leads with the project name** in
  "All Projects" mode — "In <project>: <script>" (HS-8782) — while the displayed
  transcript stays just the script. Implemented as the pure `reelSpeechText`
  helper (`announcerPip.tsx`) fed to the player's `speechTextFor` hook; a
  single-project context speaks the script unchanged.
- A **specific project** launch generates a fresh batch for that one project,
  then plays it.
- **Default context:** the active project when launched from a project tab;
  "All Projects" from a global surface (terminal dashboard / cross-project
  stats); unchanged when restoring a minimized PIP.
- Per-project targeting rides the typed API's `secret` option (→ `apiWithSecret`,
  `X-Hotsheet-Secret` header) so `entries` / `generate` / `dismiss` / `cursor`
  act on the chosen project. `dismiss` carries the entry's owning project (ids
  aren't unique across projects). `AnnouncerPlayer` is now generic over the
  entry type so each reel entry can carry `{ projectSecret, projectName }`.
- **Button on all tabs + don't-stop (HS-8758):** the Listen button shows whenever
  *any* project is enabled+keyed (overview gate), and the PIP is **no longer torn
  down on project switch** (`reloadAppState` dropped the `teardownAnnouncer`
  call) — it's a persistent singleton that keeps playing across tab/project
  changes.

**Token + cost tracking (HS-8766).** Each `generate` captures the Anthropic
response `usage` (input/output tokens) and records a row in a new
`announcer_usage` table — stored in the **shared telemetry DB** keyed by
`project_secret` (like `otel_metrics`, via `getTelemetryDb`), so both stats
pages aggregate it with the same project filter. Per-model pricing
(`ANNOUNCER_PRICING` / `announcerCost` in `src/announcer/models.ts`; Haiku
$1/$5, Sonnet $3/$15, Opus $5/$25 per 1M in/out) turns tokens into a dollar
cost. The **per-project analytics dashboard** (§71) gains an "Announcer" card
(cost / tokens / generations for the window); the **cross-project stats page**
(§70) gains an "Announcer spend" section (window total + per-project breakdown).
This is the user's **real Anthropic spend on their own key**, so it is *always*
shown as real dollars — it does **not** respect the `telemetryCostMode`
api/subscription toggle (that governs Claude Code's telemetry display).
`src/db/announcerUsage.ts` owns the CRUD + rollups; the payloads ride on
`getProjectRollupPayload` / `getDashboardPayload`.

**Summarization model (HS-8764).** A global setting (`announcerModel` in
`~/.hotsheet/config.json`) picks which Anthropic model writes the narration,
**defaulting to the cheapest** (Haiku 4.5 — $1/$5 per 1M in/out tokens) rather
than Opus, since this is high-frequency, lightweight summarization. The model
list + default live in `src/announcer/models.ts` (ordered cheapest-first, the
single source of truth shared by the wire schema, the server summarizer, and the
Settings → Announcer dropdown). `summarizeWork` falls back to the
cheapest model when the setting is unset; the generate route reads the global
config and passes the chosen model. "Least expensive for the AI tool" is
future-proofed by the cheapest-first ordering — a future provider supplies its
own ordered list + default.

**Dynamic Anthropic model discovery + same-family upgrade (HS-8853).** The
Anthropic options in the dropdown are no longer a hardcoded list: the server
queries the Models API (`client.models.list()` in `src/announcer/anthropicModels.ts`,
filtered to `claude-*`, cached per-key with a 5-minute TTL) so the dropdown
tracks the models the user's key actually offers — new Claude models appear
automatically; retired ones drop off. The `/api/announcer/status` route returns
this discovered list (`anthropicModels`), falling back to the static
`ANNOUNCER_MODELS` set when there's no key or discovery fails (the dropdown is
never empty). The Models API publishes **no pricing** (there is no pricing
endpoint), so `announcerCost` keeps a maintained price map but falls back by
**family** (haiku/sonnet/opus) for an unlisted id — a future `claude-sonnet-4-7`
prices at sonnet rates rather than the flat default. When a saved model the key
no longer offers is resolved (`resolveBestModelForSelection`), it upgrades to the
**newest available model in the same family** (a retired `claude-sonnet-4-5` →
`claude-sonnet-4-6`, *not* a jump to opus); `resolveAnnouncerModel` applies this
at generate time and the settings dropdown mirrors it. The `announcerModel`
config schema accepts any `claude-*` id (plus the on-device pseudo-ids) instead
of a fixed enum. The local provider already discovered its models this way
(§81); Apple stays a single availability-gated pseudo-entry.

**Availability-aware on-device fallback (HS-8872).** A *same-family upgrade* only
covers Anthropic ids; an explicitly-chosen **on-device** provider can simply
become unavailable on the current machine or build — a Mac without Apple
Intelligence, a beta bundle missing the helper sidecar, a stopped local endpoint,
or a local endpoint that's reachable but has no `announcerLocalModel` picked.
Before this fix `resolveAnnouncerModel` returned the saved on-device id unchanged,
so the readiness gate (`prepareSummarizationProvider`) failed **every** generate
with a misleading `"<provider> not available"` 400 — the reported symptom of
*"announcer is constantly nothing and warning message"* even though the project
had a working Anthropic key (or a different on-device provider). Now, when the
chosen on-device provider isn't ready, `resolveAnnouncerModel` falls back to the
first working one via `firstReadyAnnouncerModel` — preferring the **other
free/on-device option** (Apple, then a configured + reachable local endpoint)
before the **cheapest Anthropic** model, so a privacy/cost preference is honored
wherever one still works. When *nothing* is ready (no Apple, no local model, no
key) the saved id is left untouched so the original accurate provider error
surfaces rather than being masked behind a different model. A reachable local
endpoint with **no** `announcerLocalModel` configured counts as *not ready* (it
would otherwise throw at the summarize call).

**Playback speed (HS-8754).** A global speed multiplier (`announcerSpeechRate`
in `~/.hotsheet/config.json`, default 1×, clamped 0.5×–2×) drives the TTS rate:
the browser engine sets `SpeechSynthesisUtterance.rate`; the Tauri engine maps
it to macOS `say -r` words-per-minute (`rateToMacWpm`, base 175 WPM). It's
adjustable from a **speed select in the PIP** *and* a **global control under
Settings → Announcer** — both write the cached
`announcerSpeechRate.ts` value and broadcast `hotsheet:announcer-rate-changed`
so the two stay in sync. Changing speed mid-utterance cancels and re-speaks the
current entry at the new rate. Linux/Windows OS voices don't map rate yet
(best-effort, same as `voice`).

**Settings + Listen affordance.** `announcerSettings.tsx` binds the "Announcer"
tab (HS-8777 — promoted from a section under Settings → Experimental to its own
tab, whose label carries a blue rounded "Beta" chip): a per-project enable toggle
(`setAnnouncerEnabled`), an **Anthropic key selector** (HS-8751 — a dropdown of
named keys from the global registry, §79, filtered to type
`anthropic_api_key`, plus a "Default — first Anthropic key" option;
`selectAnnouncerKey` records the choice in the per-project `announcer_ai_key_id`
setting, and the dropdown repopulates live on the `hotsheet:keys-changed`
event), and an explicit privacy/cost disclosure. *(Pre-HS-8751 this was a
write-only key field stored under the announcer keychain id; keys now live in
the shared "API Keys" tab and the announcer just picks one.)*
`announcer.tsx` owns the header "Listen" button — hidden unless the project is
opted in AND has a key (`getAnnouncerStatus`) — which generates the latest
batch and plays the full active reel through the PIP, advancing the listened
cursor (`advanceAnnouncerCursor`) when the PIP closes.

**Session persistence across launches (HS-8804).** The PIP is otherwise
in-memory, so a reload / app relaunch lost your spot. `announcerSession.ts`
persists a snapshot to `localStorage` (`hotsheet:announcer-session`) — the
**context**, **playback position** (current entry by id + owning project),
**play/paused** state, and **open/minimized** state — saved on every relevant
change (entry change, play/pause, minimize/restore, context switch). On launch
`initAnnouncer` calls `restoreAnnouncerSession`, which rebuilds the reel for the
saved context and reopens the PIP in exactly that state via new
`openAnnouncerPip` options (`startIndex` / `startPaused` / `startMinimized`,
driving the player's new `startAt(index, autoplay)`). `resolveRestoreIndex`
maps the saved entry back to a reel index (matching id + project so colliding
ids across an "All Projects" reel disambiguate), falling back to the first entry
when the saved one is gone (dismissed, or filtered as already-listened once
HS-8803 lands). An explicit **close (X)** clears the saved session so it won't
return; a quit/reload leaves the last snapshot in place. Caveat: restoring a
*playing* session auto-speaks on load — fine for the Tauri `say` engine
(desktop primary); a browser may gate `speechSynthesis` behind a user gesture,
in which case the restored utterance simply doesn't sound until interaction.

**Spoken permission checks (HS-8781).** A global, **default-on** Announcer-tab
toggle, `announcerSpeakPermissions` (in `~/.hotsheet/config.json`), reads each
new permission popup aloud — "Permission needed in <project>: <description>" — so
you hear what Claude is asking for while you're away. **HS-8794 —** the owning
project is named in the spoken prefix (resolved from the popup's secret via
`projectsByIdSignal`), so with several projects registered you hear *which* one is
asking; an unresolvable name falls back to the un-prefixed "Permission needed:".
It's **TTS-only** (no Anthropic key or cost; uses the same `SpeechEngine` voice)
and works **independent of an active reel** — even with no PIP open. Wiring:
`permissionOverlay.tsx::showPermissionPopupBody` (the single mount point for a new
permission) calls `announcePermission(perm, projectName)`
(`announcerPermissionSpeech.ts`); the cached pref is `announcerPermissionPref.ts`.
**Arbitration:** it never interrupts a narration segment already speaking —
when the PIP is mid-segment it waits for the segment boundary
(`AnnouncerPlayer.runAtNextBoundary`) and speaks **before** the next segment,
pre-empting upcoming narration; if a permission is already resolved
(allowed/denied/dismissed — checked against `respondedRequestIds` /
`dismissedRequestIds`) by the time its turn arrives, it's skipped. Deduped per
`request_id`; long descriptions are word-boundary-trimmed to a short summary.
**HS-8816 —** the boundary task `scheduleDrain` hands to `runAtNextBoundary`
now **returns** its `drain()` promise (it previously fire-and-forgot it). The
player's `drainBoundaryThenAdvance` `await`s the boundary task before advancing,
so the permission voice now finishes *before* the next reel segment speaks;
without the returned promise the task resolved instantly, the reel advanced, and
the next narration segment played on top of the permission announcement (two
voices overlapping). Regression-covered by a deferred-resolution engine test in
`announcerPermissionSpeech.test.ts`.

**Channel chatter excluded from the reel (HS-8795).** The after-the-fact
narration is about *project work*, not channel bookkeeping, so `collectWorkSignals`
(`src/announcer/collectSignals.ts`) drops command-log events of type
`permission_request` (permission needed AND granted) and `done` ("Claude
finished") from the assembled material — the live spoken announcement above
already covers a permission the moment it's needed, and re-narrating long-resolved
grants or "Claude finished" is noise. `trigger` events (the worklist message that
kicked off the work) are still narrated.

**Multi-provider summarization + Apple Foundation Models (HS-8790).** The model
registry (`src/announcer/models.ts`) is now **provider-tagged** (`providerForModel`)
and `summarizeWork` routes by provider: `anthropic` calls the Messages API with
the user's key (cloud); **`apple`** runs **on-device** via Apple Foundation Models
(macOS 26 + Apple Intelligence) — free, private, no key, `usage = null`. Apple
inference goes through a bundled **Swift CLI helper** the *server* shells out to
(`src/announcer/appleFoundation.ts` → `src-tauri/apple-fm-helper/main.swift`), so
it works in both Listen and live mode (see docs/tauri-architecture.md §"Apple
Foundation Models helper" for build/bundle/signing). **HS-8876** — the packaged
desktop app now actually ships the helper: `build-sidecar.sh` compiles it into the
bundled `server/` dir for arm64 macOS, the macOS pre-sign step signs it for
notarization, and the Rust launcher points the server at it via
`HOTSHEET_APPLE_FM_BIN` — so `appleAvailable` is true in the installed app, not
just in `npm run tauri:dev`. (CI must build the arm64 job on a `macos-26` runner —
`macos-latest` is macOS 15 / Xcode 16 and self-skips the helper.) Availability is probed once
+ cached and surfaced via `appleAvailable` on `/announcer/status` + `/overview`;
when available it becomes the **default** model (explicit `announcerModel` still
wins), and the Listen button/generation no longer require an Anthropic key. The
settings UI puts the **model field first** and shows the **Anthropic key field
only for an Anthropic model**; the on-device option is hidden where unavailable.
A future cross-platform **local/Ollama** provider (Linux + non-Copilot+ Windows)
slots into the same `providerForModel` seam (follow-up).

**On-device failure resilience + soft generate errors (HS-8805).** An on-device
provider can report **available** at probe time yet still **fail at inference**
(the Apple FM Swift helper exits **code 4** = "inference failed"; a local
endpoint can refuse mid-request). Two fixes so this no longer surfaces as an
alarming overlay on dialog open:
- **Auto-fallback to Anthropic.** When the model was **auto-selected** (no
  explicit `announcerModel`) and resolved to an on-device provider, the generate
  path resolves an Anthropic key and hands it to `summarizeWork` as
  `anthropicFallbackKey`; if the on-device call throws, it transparently retries
  with the cheapest Anthropic model. An **explicit** on-device choice is
  respected (no fallback key resolved) so a privacy/cost preference is never
  silently overridden. `SummarizeResult.modelUsed` carries the model that
  actually ran so cost is attributed to the Anthropic fallback model (not the
  on-device id, which `announcerCost` prices at $0).
- **Soft generate errors.** A summarization failure with no fallback available
  is **recoverable, not a server fault**, so `POST /api/announcer/generate` now
  returns **200** with `{ entries: <existing reel>, generated: 0, error }`
  instead of a **502**. The client's generic api layer pops its "Connection
  Error" overlay on any `status >= 500`; returning 200 keeps the existing reel
  playing and lets the client show a gentle toast from the soft `error`.

**Opt-in fallback for an explicit Apple primary (HS-8891).** The HS-8805 auto-
fallback deliberately does NOT fire for an *explicit* Apple choice (so a
privacy/cost preference isn't silently overridden). HS-8891 lets the user opt in:
when the primary is **Apple Intelligence**, the settings UI shows an optional
**"Fallback model if Apple Intelligence fails"** dropdown (global
`announcerFallbackModel`) listing the **non-apple** options — the Anthropic models
the key offers, plus the local option when a local endpoint is reachable; default
**"None"** = the pre-HS-8891 behavior (Apple failure → no narration). The pure
policy `decideAnnouncerFallback(provider, autoSelected, configuredFallbackModel)`
(in `generate.ts`) decides: auto-on-device → Anthropic default (HS-8805);
**explicit Apple + a configured fallback → that model** (an Anthropic id needs the
key, a `local` id uses the configured endpoint, free); everything else → none.
`summarizeWork`'s `fallbackModel` opt then routes the failure to the chosen
provider. Scope (per the HS-8886-style decisions on the ticket): the selector is
shown **only for an Apple primary**, the fallback may be **Anthropic OR local**,
and it applies to **both Live and manual** generation (it's the shared
`generateAnnouncementsOnce` path). When set to an Anthropic model it spends on the
user's key whenever Apple FM fails — surfaced by a hint on the field + the
retention copy.

**Promotes §78.5 (content tier 1 — text transcript) and §78.6 (settings UI +
TTS providers: Tauri `say` desktop primary, browser `speechSynthesis`) from
design to shipped.** The **draggable PIP** + remembered position (HS-8756) and
**minimize-with-glow** (HS-8757) also shipped 2026-06-05. Code-diff visuals
(§78.5 tier 2), a *resizable* PIP, the 10s audio-timeline seeks, "mark
uninteresting" learning, and Google Cloud TTS remain later-phase.

**Tests.** `client/announcerPlayer.test.ts` (sequential play, pause/resume on
both backend kinds, nav, skip/dismiss, the stale-resolution guard, the
transcript-only `none` backend) + `client/tts.test.ts` (backend selection +
each engine's `ended`/`cancelled`/`error` contract) = 20 unit tests.
`e2e/announcer.spec.ts` drives the real client (Listen-button gate → PIP →
next/prev/skip/close → cursor advance) with the announcer routes intercepted
and `speechSynthesis` stubbed, so it's hermetic (no live API, no keychain, no
real audio).

**Cross-platform Rust tests.** The per-platform OS-voice/kill command
construction in `src-tauri/src/lib.rs` was refactored from `#[cfg(target_os)]`
blocks into pure, platform-parameterized functions (`build_tts_command` /
`build_kill_command`, taking a `TtsPlatform` enum) so **all three platforms are
unit-tested on any host** — `cargo test` (`npm run test:rust`) asserts the
macOS `say` argv (with/without voice+rate, empty-voice handling), the Linux
`spd-say --wait` argv, the Windows PowerShell `System.Speech` form (text passed
via the `HOTSHEET_TTS_TEXT` env var, never argv), and the unix `kill` vs Windows
`taskkill` interrupt commands (8 tests). This is the only automated coverage of
the Linux/Windows voice paths until the desktop pass (HS-8748); actual process
spawning + audio output still needs that manual pass.
