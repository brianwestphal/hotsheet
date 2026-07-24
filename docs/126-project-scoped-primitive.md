# 126. `projectScoped` — the per-project client-state primitive

HS-9416. The structural guard designed in [`125-project-scoped-client-state.md`](125-project-scoped-client-state.md)
§125.5, layers 1–2. Layer 3 (the ESLint backstop) is §126.6.

**If you are adding module-level mutable state to `src/client/**`, read §126.2 first.**

## 126.1 The problem it solves

Eleven shipped bugs share one shape: client state belonging to project A survived a switch to
project B (the full list is docs/125 §125.1). Each was fixed individually, at the call site, after a
user noticed.

The docs/125 audit found that the caches which *never* leaked are the ones **keyed by project
secret** — not the ones reset in `reloadAppState()`. Keying makes the wrong value *unreachable*,
including during fetch failures and races, which is exactly where the worst two leaks did their
damage. Resetting only works while somebody maintains a hand-written list of ~18 refresh calls.

`projectScoped` generalizes keying to a one-line declaration, **including for scalars** — which a
keyed-`Map` convention alone cannot reach, and which is what most of the leaks actually were.

## 126.2 Using it

```ts
import { projectScoped } from './projectScoped.js';

// Instead of:  let lastSeenId = 0;
const lastSeenId = projectScoped(() => 0, 'commandLog.lastSeenId');

lastSeenId.get();            // this project's value, or a fresh initial
lastSeenId.set(entry.id);
lastSeenId.clear();          // drop this project's value
```

It works for caches too, replacing hand-rolled two-level keying:

```ts
const proofCache = projectScoped(() => new Map<string, CachedProof>(), 'reviewProof.proofCache');
proofCache.get().set(ticketNumber, entry);
```

The `label` is optional but worth setting — it appears in the isolation harness's failure messages.

**Rules of thumb**

- **Per-project → `projectScoped`.** Anything derived from a project-scoped API response, or any
  user state that means something different in another project.
- **Genuinely global → a plain `let`, and say why in a comment.** Timers, DOM element handles, the
  server-busy chip, cross-project surfaces. See §126.5 for the one subtle case.
- **Never reset-on-switch.** A reset throws the old project's value away, so switching back re-fetches
  or, worse, re-enters a "first load" branch. `projectScoped` remembers each project independently.

## 126.3 Design

Three constraints, all load-bearing:

1. **It must be less code than the status quo.** It replaces both the bare `let` and the
   `Map<secret, T>` + lookup boilerplate. A primitive that costs more than the buggy pattern does not
   get adopted, and adoption is the whole point.
2. **The active secret is read at ACCESS time**, from `projectsStore` — not pushed in on switch. A
   pushed copy is one more thing that can desync; reading means a cell is correct the instant the
   active project flips, with no ordering requirement against `reloadAppState`.
3. **No import cycle.** `projectScoped.ts` depends only on `projectsStore` (a leaf). `state.tsx`
   depends on the primitive (it calls `evictProjectScope`), never the reverse.

**Storage is boxed** (`Map<ScopeKey, { v: T }>`) so a cell whose `T` includes `undefined`
distinguishes "written as undefined" from "never written" — and so `get()` needs no type assertion,
per the project's default-to-no-`as` rule.

**Before any project is active** (boot, or after the last project is removed) reads return the
initial rather than throwing — cells are constructed at import time, long before the project list
loads. Writes in that window go to a distinct `NO_PROJECT` symbol bucket, so a boot-time value is
retained for reads in that same window but can never surface once a real project is selected.

**Eviction** is centralized: `state.tsx::clearPerProjectSessionState(secret)` calls
`evictProjectScope(secret)`, which drops that secret across every cell that exists now or is ever
added. A cell author writes no cleanup.

## 126.4 The generic isolation harness

`projectScopedIsolation.test.ts` walks **every registered cell** and asserts the three legs:

1. project B must not see project A's value,
2. project B must see its own initial, and
3. switching back to A must still return A's value.

Leg 3 is what separates real scoping from a reset-on-switch.

**Adopting modules are discovered, not listed.** The harness greps `src/client` for `projectScoped(`
and imports exactly those files, so a cell declared in a new module is covered the day it is written.
A hard-coded list would reintroduce the "did you remember?" failure mode the guard exists to remove.

Two supporting tests keep the harness honest: one asserts discovery found something (so the suite
can't pass vacuously), and one demonstrates the harness *would* catch a leaking module-level `let`.

## 126.5 The subtle case: state that describes the DOM

`reviewProofSection.tsx` and `ticketTelemetryStats.tsx` each track "which ticket is currently painted
in my container". Scoping that per project is **wrong**, and doing so surfaced a second bug during
HS-9416: with a per-project `currentTicket`, switching back to project A found its stale `HS-42`,
reported "not switching", and the unchanged-signature guard then accepted **project B's DOM** as
already-painted — leaving B's review notes on screen under project A.

The container is a single shared DOM node, so "what is painted" is global by nature. The fix is a
global `paintedKey` holding a **composite** `secret::ticketNumber`, which makes a project switch count
as a switch even when the ticket number is identical:

```ts
let paintedKey: string | null = null;
const keyFor = (ticketNumber: string) => `${getActiveProject()?.secret ?? ''}::${ticketNumber}`;
```

The general rule: **scope the data, composite-key the view state.** Ask what the variable describes —
a project's data (scope it) or a shared DOM node (make the key include the project).

## 126.5a Testing a module that uses a cell

The cell resolves its scope from **`projectsStore`** directly (it must, to avoid the
§126.3 import cycle). Many modules instead read `getActiveProject()` from `state.tsx`.
In production those are the same source, so this never matters — but **a test that
mocks only `getActiveProject` will not move the cell's scope**, and every project will
share one cell, silently defeating the isolation the test is trying to check.

Drive both:

```ts
function activate(secret: string): void {
  mockGetActiveProject.mockReturnValue({ secret });
  projectsStore.actions.setActive({ secret, name: secret, dataDir: `/tmp/${secret}` });
}
```

(`analyticsTelemetrySectionCacheAndPoll.test.tsx` is the worked example.) Tests that
don't mock `getActiveProject` at all just need `projectsStore.actions.setActive`.

## 126.6 Layer 3 — the ESLint backstop (HS-9417, shipped)

`PROJECT_SCOPED_CACHE_RULE` in `eslint.config.mjs` flags module-level
`new Map/Set/WeakMap/WeakSet` in `src/client/**`, allowlisted like the §62 `innerHTML =` rule —
25 files, each with an inline reason so a reader doesn't have to re-derive why it's exempt.

Layers 1–2 make the right thing easy and automatically tested; **only the lint rule makes the wrong
thing hard to write**, which is what distinguishes this from the previous ten point fixes.

**Scoped to the cache shape on purpose.** A `Program > VariableDeclaration[kind='let']` selector
flags **88 client files**, overwhelmingly timers, DOM handles, and disposers. An error rule at that
false-positive rate trains reflexive allowlisting, at which point the allowlist stops being read and
the next real violation is waved through with everything else — worse than no rule.

### The scalar half — `hotsheet/no-unscoped-project-state` (HS-9419, shipped)

A selector can't reach `let lastSeenId = 0`, which is the shape most of the docs/125 leaks actually
had. `eslint-rules/no-unscoped-project-state.mjs` is a local rule that adds the context a selector
language lacks:

- **H1** — only files that import `../api/index.js`. A module that never fetches project data has no
  per-project state to leak.
- **H3** — skip declarations whose type/initializer/name identifies them as infrastructure: timer
  handles, DOM elements, observers, sockets, promises, disposers.

Measured effect: **207 declarations across 89 files → 99 across 45.**

**Reported at `warn`, with the 46 then-existing files seeded into an off-list**, so it is silent on
today's code and speaks only for net-new modules — the same working model as the innerHTML and cache
allowlists. It stays at `warn` because the remaining set legitimately contains one-time init flags
(`let wired = false`) that no heuristic separates from per-project data; an error rule at that
precision gets allowlisted reflexively, and then the allowlist stops being read. Promote to error
once the seed list is worked down far enough to trust the remainder.

The rule has its own **RuleTester suite** (`no-unscoped-project-state.test.mjs`, 19 cases) covering
both heuristics in both directions. An unverified lint rule is worse than none: a false negative
silently removes protection everyone assumes exists.

**HS-9423** tracks triaging the seed list — reading it, several entries are not false positives but
real per-project data held globally (`settingsScope::layered`, the command/terminal/auto-context
editor arrays, and `poll::pollVersion`, which is structurally identical to the HS-9412 bug).

**Config note.** The four `no-restricted-syntax` selectors are now hoisted into named consts
(`BIND_DISPOSER_RULE`, `CORE_RULES`, `PROJECT_SCOPED_CACHE_RULE`) so each block composes the set it
wants. Previously every block re-declared the whole array, which meant adding a rule could silently
re-enable others for allowlisted files. The two allowlists (innerHTML, project-cache) are kept
**disjoint** on purpose: a file in both would hit flat-config's later-wins merge and get the innerHTML
rule turned back on.

## 126.7 Adoption status

Migrated (HS-9412–9415): `commandLog.lastSeenId`, `reviewProof.proofCache`,
`ticketTelemetry.rollupCache`. Also fixed alongside: `ticketList::buildScopeKey` (project added to
the key) and `claimsStore` (reset + refetch on switch).

**HS-9418** folded in three of the four hand-rolled keyed caches:

| Cache | Outcome |
| --- | --- |
| `gitStatusChip::lastStatusBySecret` | → `projectScoped`. Also **deleted `pickDisplayStatusOnProjectSwitch`** — that helper existed only to turn "no entry for this secret" into `null`, which is exactly what a cell's initial does. |
| `analyticsTelemetrySection::cachedAnalyticsPayloads` | → `projectScoped(() => new Map<TelemetryWindow, …>())`. The two-dimensional `"<secret>|<window>"` key collapses to the project dimension in the cell and the window dimension in a plain Map. |
| `toolPrepNudge::checkedSecrets` | → `projectScoped(() => false)`. A `Set<secret>` used as a per-project flag is exactly a scoped boolean. |

**`dashboardMode::stickyCostCache` was deliberately NOT converted.** It is written for
**every** project at once from the bulk `/api/telemetry/today-cost-by-project` response and
only *read* for the active one. `projectScoped.set()` writes the active cell only, so the
conversion would silently drop every other project's cached cost. It stays a hand-rolled
`Map<secret, number>` — a **cross-project write, per-project read** cache, which is a
different shape from everything else here and correctly outside the primitive's remit.

That distinction is the general test: **`projectScoped` fits state the active project both
writes and reads.** State written for many projects at once belongs in a plain keyed Map.

**Graduating usually narrows an allowlist entry rather than removing it.** `toolPrepNudge` left the
HS-9417 list entirely, but `gitStatusChip` and `analyticsTelemetrySection` still hold one global
structure each — `inFlightByKey` (in-flight request promises, for coalescing) and
`lastPaintedAnalyticsFor` (a WeakMap keyed by DOM nodes, §126.5 paint state). Both stay listed, with
the reason rewritten to say exactly what is left. Expect that outcome: a file's *data* cache moves to
the primitive while its request-plumbing and DOM-keyed state legitimately stay put.

## 126.8 Triage of the HS-9419 seed list (HS-9423)

The scalar lint rule was seeded with 46 files, and reading that list several entries looked like
per-project data held in a module-level `let`. Audited; **no new confirmed bugs**, but the exercise
produced a rule of thumb worth keeping.

### The distinction that decides it

`reloadAppState()` refreshes most of this state on a project switch — but **how** it calls the
refresh is what separates safe from transiently-wrong:

- **`await`ed** → safe. Nothing can read the stale value, because the switch doesn't complete until
  the refresh does. (`loadCustomViews`, `loadSettings`, `loadCategories`.)
- **`void`-ed (fire-and-forget)** → a real window where the UI paints the PREVIOUS project's data.
  Self-correcting, usually within a frame or two, but visibly wrong while it lasts.

That is the same shape as the `claimsStore` case fixed in HS-9415, where the fix was to clear
synchronously and let the refetch repaint.

### Findings

| State | Verdict |
| --- | --- |
| `poll::pollVersion` / `pollDataVersion` | **CLEARED — my hypothesis was wrong.** I flagged these as structurally identical to the HS-9412 `lastSeenId` bug. They aren't: `changeVersion`/`dataVersion` in `routes/notify.ts` are **process-global** module state, not per-project, so a client-side global is the *correct* mirror. Recorded so nobody re-investigates. |
| `experimentalSettings::commandItems` (+ `commandShared`, `editTree`, `commandOverriddenIds`) | **Transient.** Refreshed via `reloadAppState → void initChannel() → reloadCustomCommands()` — fire-and-forget, so the command sidebar can paint the previous project's buttons briefly. Worth converting. |
| `commandLog::panelOpen`, `activeTab` | **Transient**, same shape (`void applyPerProjectDrawerState()`). |
| `customViews::viewLayers` | Safe — `await loadCustomViews()` in `reloadAppState`. |
| `ticketRefs::cachedPrefixes` | Safe — explicitly re-fetched (HS-8053). |
| `settingsScope::layered`, `settingsDialog::autoContext*`, `terminalsSettings::terminals*` | Safe **in practice**: only read while the settings dialog is open, and repopulated on open. Stale between a switch and the next open, but nothing reads it. Fragile by construction rather than broken. |
| `feedbackDialog::lastAutoShownKey` | Effectively safe. The key is `ticketId:noteId`; `ticketId` repeats across projects, but `noteId` is a random unique string, so a cross-project collision is not reachable. Project-ambiguous in shape only. |

### Recommendation

Convert the two transient cases, and prefer `projectScoped` over "it gets refreshed" for the
dialog-scoped ones when those files are next touched — "nothing reads it before the refresh" is a
runtime-ordering argument, and runtime ordering is exactly what the eleven docs/125 bugs kept
invalidating. Tracked by HS-9425.
