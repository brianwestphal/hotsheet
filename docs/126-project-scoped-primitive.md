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

## 126.6 Layer 3 — the ESLint backstop

Tracked by HS-9417. A `no-restricted-syntax` rule flagging module-level mutable bindings in
`src/client/**` that aren't `projectScoped`, allowlisted exactly like the §62 `innerHTML =` rule.

Layers 1–2 make the right thing easy and automatically tested; **only the lint rule makes the wrong
thing hard to write**, which is what distinguishes this from the previous ten point fixes.

## 126.7 Adoption status

Migrated (HS-9412–9415): `commandLog.lastSeenId`, `reviewProof.proofCache`,
`ticketTelemetry.rollupCache`. Also fixed alongside: `ticketList::buildScopeKey` (project added to
the key) and `claimsStore` (reset + refetch on switch).

Not yet migrated — the already-safe hand-rolled keyed caches (`gitStatusChip::lastStatusBySecret`,
`analyticsTelemetrySection::cachedAnalyticsPayloads`, `dashboardMode::stickyCostCache`,
`toolPrepNudge::checkedSecrets`). They are correct today; folding them in is worth doing so the
codebase has one convention rather than five spellings of it, and so the harness covers them.
Tracked by HS-9418.
