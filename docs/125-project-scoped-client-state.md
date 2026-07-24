# 125. Project-scoped client state (investigation)

HS-9409. **Investigation only — nothing here is implemented.** Findings, four newly-confirmed
leaks, and a recommended structural guard, with follow-up tickets filed for the work.

## 125.1 The class

Nine bugs to date, all the same shape: **client state belonging to project A survived a switch to
project B.**

| Ticket | Symptom |
| --- | --- |
| HS-8451 | App title frozen at the first project's name |
| HS-8053 | Ticket prefixes never re-fetched — `DM-123` refs didn't linkify in Domotion |
| HS-8062 | Detail panel not re-rendered for the new prefix set |
| HS-7993 | Sidebar git chip kept the previous project's branch / dirty count |
| HS-8737 / HS-8738 | Tag autocomplete + custom-view tag filter showed the old project's tags |
| HS-9406 | `ai_tool` carried over — a Claude project's command editor said "Codex" |
| HS-9407 | The rest of `loadSettings` — detail geometry, layout, sort, notify levels |
| **HS-9409-a … -d** | **Four more, found by this audit — see §125.3** |

Each was fixed individually, at the call site, after a user noticed. The pattern is not that any one
of these was careless; it's that **nothing in the codebase makes per-project state visible as a
category**, so "reset this on switch" is a thing a person has to remember, every time, forever.

## 125.2 Why it keeps happening

Three compounding reasons:

1. **`reloadAppState()` is a hand-maintained list.** `src/client/app.tsx` calls ~18 refresh
   functions in sequence. Adding a per-project cache anywhere in `src/client/**` requires knowing
   that this function exists and editing it. Nothing enforces or even hints at that.
2. **The bug only exists in a SEQUENCE.** Every test opens one project, exercises a feature, and
   asserts. That passes on leaking code. You need A → B (→ A) to see it, and almost nothing does
   that. This is the "coverage is a floor, not a ceiling" case from `CLAUDE.md` in its purest form:
   100% line coverage is compatible with 100% of these bugs.
3. **Per-project state is untyped and unnamed.** A `let lastSeenId = 0` at module scope looks
   identical whether it holds a per-project cursor or a global one. There is no `ProjectScoped<T>`,
   no naming convention, no lint rule. Reviewers can't see the category either.

## 125.3 Audit findings

Method: enumerated every module-level mutable binding under `src/client/**` (233 across 67 files
that also touch project-scoped APIs), then classified each by what happens on a switch.

### Confirmed leaks (new)

**(a) `commandLog.tsx::lastSeenId` — the Commands Log unread badge is wrong after a switch.**
`lastSeenId` is a cursor into `command_log.id`, which is a `SERIAL PRIMARY KEY` **in each project's
own database** — so ids restart per project. Never reset on switch.
*Failure:* switch from a project with 500 log entries to one with 20 → `entries[0].id` (20) is never
`> lastSeenId` (500), so the badge **never appears** for the new project until its log passes the
old project's high-water mark. Reverse direction: the badge lights immediately with nothing new.

**(b) `reviewProofSection.tsx::proofCache` — shows the WRONG PROJECT'S code review.**
`Map<ticketNumber, {sig, notes, commits}>`, keyed by ticket number alone. The only `.clear()` is
`_resetReviewProofForTests`. Ticket numbers collide across projects whenever two projects share a
prefix — and `HS-` is the default, so most do.
*Failure:* open `HS-42` in project B; if project A's `HS-42` is cached, `render(container,
cached.notes, cached.commits)` paints **project A's review notes and commits immediately**, before
the fetch resolves. Worse, when both fetches fail the code deliberately keeps what's shown
(`if (proof === null && commits === null) return;`) — so a transient network error leaves the wrong
project's code review on screen indefinitely.
*Irony:* HS-9402 fixed the **ticket → ticket** version of this exact staleness two days ago. The
**project → project** version was invisible because it needs a switch to reproduce.

**(c) `ticketTelemetryStats.tsx::rollupCache` — shows the wrong project's cost/token stats.**
Identical shape to (b): `Map<ticketNumber, TicketRollup>`, `resetCache()` is test-only, renders the
cached value immediately, and keeps it on fetch failure.

**(d) `ticketList.tsx::buildScopeKey()` omits the project.** The key is
`view|search|sort|dir|layout|includeBacklog|includeArchive`. Switching to a project whose filter
state matches leaves `lastScopeKey` equal, so `state.listLimit` is not reset to `LIST_PAGE_SIZE`.
*Failure:* low severity — the new project over-fetches (a page size inherited from how far the user
had scrolled in the previous project), no wrong data. Included because it is the same class.

### Transient (self-healing, but wrong in the window)

- **`claimsStore.ts::claimsSignal`** — holds the active project's claim rows. `reloadAppState` does
  not refresh it, so the claimed-by chips show the **previous project's claims for up to 5 s** until
  the poll fires (or sooner via a `/ws/sync` `claims-changed` push). Self-heals; still visibly wrong.

### Already handled — and the reason they're safe

Worth recording, because these are the pattern to generalize:

| State | Why it's safe |
| --- | --- |
| `gitStatusChip.tsx::lastStatusBySecret` | `Map` **keyed by project secret** (the HS-7993 fix) |
| `analyticsTelemetrySection.tsx::cachedAnalyticsPayloads` | keyed by `cacheKey(projectSecret, window)` |
| `dashboardMode.tsx::stickyCostCache` | keyed by secret |
| `toolPrepNudge.tsx::checkedSecrets` | `Set` of secrets |
| `ticketList.tsx::lastScrollKey` | `computeScrollKey()` includes the secret |
| `ticketRefs.ts::cachedPrefixes` | explicitly re-fetched (`reloadTicketPrefixes`, HS-8053) |
| `commandLog.tsx::activeTab`, drawer open state | restored per project by `applyPerProjectDrawerState` |
| `crossProjectStatsPage.tsx::cachedPayloads`, `bellPoll.tsx` | cross-project **by design** |

**The safe ones are overwhelmingly the keyed-by-secret ones.** The reset-on-switch ones are safe only
as long as someone maintains `reloadAppState`.

## 125.4 Guard options evaluated

**A. An `onProjectSwitch(fn)` registry.** Modules register a reset callback; `reloadAppState` fires
them all. *Verdict: insufficient alone.* It centralizes the calls but does not change the failure
mode — a new cache that forgets to register is still a silent bug. It's `reloadAppState` with a
nicer shape. (`terminal.tsx::onProjectSwitch` is already an ad-hoc instance of this.)

**B. Key every per-project cache by secret.** *Verdict: the right core.* Stale data becomes
structurally impossible rather than remembered — there is no moment at which the wrong project's
value is reachable, so it can't be shown even in a fetch-failure or race window (which is exactly
where (b) and (c) do their damage). Every already-safe cache in the table above is this pattern.
Costs: unbounded growth (bounded in practice — these maps are tiny, and entries can be evicted when
a project is unregistered), and it doesn't by itself cover scalar state like `lastSeenId` or
`currentTicket`.

**C. kerf `defineStore` scoping.** *Verdict: too narrow today.* Only a minority of client state has
migrated to `defineStore` (§61); most of the leaks found are plain module `let`s that the framework
never sees. Worth revisiting if the migration completes.

**D. An A→B→A test harness.** *Verdict: necessary, not sufficient.* It converts the class from
"discovered by users" to "fails in CI", but it can only walk state it knows about — same adoption
problem as A, and it cannot reach module-private variables at all.

## 125.5 Recommendation

**No single option closes the class**, because the root cause is that per-project state is *implicit*.
The recommendation is three layers, in dependency order — each is useful alone, and together they
turn "remember to reset" into "you cannot express it wrong":

1. **A `projectScoped<T>()` primitive** (option B, generalized to scalars). A cell whose get/set
   reads the active project's secret internally:
   ```ts
   const lastSeenId = projectScoped<number>(() => 0);
   lastSeenId.get();        // this project's value (or the initial)
   lastSeenId.set(entries[0].id);
   ```
   Backed by a `Map<secret, T>`. **Adoption is driven by it being less code than the status quo** —
   it replaces both the bare `let` and the hand-rolled `Map<secret, T>` boilerplate. One place to
   evict on project unregister, and it covers scalars, which B alone does not.

2. **Self-registration + one generic test** (option D, without the adoption problem). Every
   `projectScoped` cell registers in a module-private list, so a single test can walk
   A → B → A across all of them and assert isolation. New cells are covered the day they're written,
   with no per-feature test to remember.

3. **An ESLint backstop.** A `no-restricted-syntax` rule flagging module-level mutable bindings in
   `src/client/**` that aren't `projectScoped`, with an allowlist for the genuinely-global ones
   (`serverBusyChip`, `longTaskObserver`, cross-project surfaces). **This is the layer that makes it
   structural rather than aspirational**, and the codebase already uses exactly this shape twice —
   the §62 `innerHTML =` allowlist and the `JSON.parse(x) as T` rule. Ship it last, once the
   allowlist can be generated from the audit rather than guessed.

Layer 3 is what distinguishes this from the previous eight fixes. Without it, the tenth leak is a
matter of time.

## 125.6 Follow-ups filed

| Ticket | Work |
| --- | --- |
| HS-9412 | Fix (a) `commandLog::lastSeenId` — unread badge wrong after switch |
| HS-9413 | Fix (b) `reviewProofSection::proofCache` — wrong project's code review |
| HS-9414 | Fix (c) `ticketTelemetryStats::rollupCache` — wrong project's cost stats |
| HS-9415 | Fix (d) + claims: `buildScopeKey` project term, `claimsStore` refresh on switch |
| HS-9416 | Build the `projectScoped<T>()` primitive + self-registration + the generic A→B→A test (layers 1–2) |
| HS-9417 | ESLint backstop rule + allowlist (layer 3), after HS-9416 |

HS-9412 – HS-9414 are worth fixing directly rather than waiting for the primitive: (b) and (c) show
another project's data to the user, and each is a small keying change.
