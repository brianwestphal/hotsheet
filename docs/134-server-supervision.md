# 134. Server process supervision

How the Tauri shell notices that the Hot Sheet server process has died, what it tells the user,
and whether it should restart it.

Companion to [8-cli-server.md](8-cli-server.md) (what the server process is),
[10-desktop-app.md](10-desktop-app.md) (the Tauri wrapper) and
[45-pglite-robustness.md](45-pglite-robustness.md) (the watchdog, which handles the *other* way the
server stops serving — a wedge rather than an exit).

**Status: detection + notice SHIPPED on both launch paths; restart is the open decision.**
§134.3 shipped as HS-9558 (dev), §134.4 as HS-9564 and §134.5 as HS-9565 (production parity).
§134.6 is the decision this document exists to frame (HS-9563) — nothing in it is built.

---

## 134.1 Why this exists

On **2026-08-03** the dev server process exited at 10:07:54Z. The Tauri window kept showing a fully
rendered page against a dead `localhost:4174` for **49 minutes**, until the maintainer returned,
force-quit, and relaunched. It was reported as "Hot Sheet hung".

Two separate failures produced that. The diagnosis is HS-9561:

1. **Nothing recorded why it died.** Closed by HS-9557 (dev) and HS-9565 (production, [§134.5](#1345-production-sidecar-stderr-shipped-hs-9565)).
2. **Nothing said that it died.** The window is served *by* the server, so when the server goes the
   page stays on screen looking healthy. Closed by HS-9558 (dev) and HS-9564 (production,
   [§134.4](#1344-production-death-notice-shipped-hs-9564)).

Neither of those *restarts* anything, which is the question HS-9563 asks and
[134.6](#1346-the-decision-should-the-shell-restart-the-server) frames.

**The distinction that organizes this document:** the server can stop serving two ways, and they
need different machinery.

| | detected by | response |
|---|---|---|
| **Wedge** — loop pinned, process alive | the docs/45 watchdog (worker thread, SAB heartbeat) | SIGKILL, so the next launch can take the port + locks |
| **Exit** — process gone | the shell, which reaps the child | *this document* |

A wedge eventually becomes an exit, because the watchdog kills it. So supervision sits downstream
of the watchdog and must not fight it — see [134.7](#1347-what-must-not-regress).

---

## 134.2 Current behavior

There are two launch paths and they are **not** symmetric. Both live in `src-tauri/src/lib.rs`.

### 134.2.1 Dev (`#[cfg(debug_assertions)]`)

Spawns `node --import tsx src/cli.ts --no-open --replace` **once, inline in `.setup()`**. Two
reader threads: stdout (drives the splash→app `window.navigate` handshake and
`[lifecycle:progress]`) and, since HS-9557, stderr (drained into `~/.hotsheet/server-stderr.log`).

On child exit the stdout thread calls `child.wait()` and then:

- **quitting** → `app.exit(0)`.
- **not quitting** → logs `[dev] server exited UNEXPECTEDLY (<detail>)` and emits `server-exited`
  to the window, which raises the HS-9558 overlay. **No restart.**

### 134.2.2 Production (`#[cfg(not(debug_assertions))]`)

Spawns the bundled `hotsheet-node` sidecar via `spawn_sidecar_and_navigate`, using Tauri's shell
plugin — so stdout/stderr/exit arrive as `CommandEvent`s on one channel rather than as threads.

On child exit (the event channel closing):

- **quitting** → `app.exit(0)`.
- **not quitting, never navigated** → a `settings.json` port fallback (a *launch* failure).
- **not quitting, already navigated** → logs the cause and emits `server-exited` (HS-9564). **Before
  that ticket this branch did not exist at all** — the steady-state case, i.e. precisely the
  2026-08-03 scenario, fell through to nothing.

### 134.2.3 The asymmetry, stated plainly

As originally found — dev was ahead of production on every row, which is backwards, since dev is
one maintainer who can read a log and relaunch while production is every user of the shipped app:

| | dev | production (before) | production (now) |
|---|---|---|---|
| death is logged durably | ✅ HS-9558 | ❌ `eprintln!` only | ✅ HS-9564 |
| user is told | ✅ HS-9558 overlay | ❌ nothing | ✅ HS-9564 |
| child stderr persisted | ✅ HS-9557 | ❌ `eprintln!` only | ✅ HS-9565 |
| restart | ❌ | ❌ | ❌ (§134.6) |

The client half (`src/client/serverExited.tsx`) was launch-path-agnostic from the start and needed
**no changes** — production simply never fired the `server-exited` event.

A quiet corroboration of the gap: `cargo check --release` emitted
`warning: function describe_child_exit is never used` from HS-9558 until HS-9564 landed. Production
never called the function that describes a death, because it never reported one.

---

## 134.3 The dev death notice (SHIPPED, HS-9558)

`describe_child_exit` renders the cause: the exit code, or — for `None` — a note that
it was killed by a signal. The `None` case is the diagnostic one: a Unix child killed by a signal
has no exit code, and the two signals that actually occur here are **the docs/45 watchdog's own
SIGKILL** and **the OS OOM killer**. Both are strong evidence about what happened.

The overlay is permanent and has no dismiss control (nothing in the window works any more), and it
*replaces* the "Connection Error" popup rather than stacking behind it — the shell **reaped the
child**, so "the server is gone" is a fact here, not the guess a failed fetch makes.

---

## 134.4 Production death notice (SHIPPED, HS-9564)

**Was a bug, not a decision.** Production now reaches dev parity: on the channel closing without a quit
in progress, log the cause durably (`startup_log`, which is release-only and file-backed) and emit
`server-exited` with a `describe_child_exit`-style string.

Production has *more* information available than dev: `CommandEvent::Terminated` carries both
`code` and `signal`, so it names the actual signal instead of listing the likely culprits.
`describe_child_exit(code, signal)` took a signal parameter; the dev path passes `None` (reaping the
child yields only `ExitStatus::code()`) and keeps the generic wording.

**Which signal it was decides the investigation**, which is why it is worth the parameter:
**SIGKILL** is the docs/45 watchdog or the OS OOM killer; **SIGABRT** is an abort, typically a
V8/WASM out-of-memory; **SIGSEGV** is a native crash. An unknown number is reported bare rather
than guessed at. An exit code, when present, wins over a signal — both being set is contradictory,
and a clean exit must never be reported as a kill.

The `!navigated` branch stays as-is: a sidecar that dies before the handshake is a *launch* failure,
already covered by the HS-8704 startup-log machinery, and the `settings.json` fallback exists to
rescue the "joined an existing instance" case.

---

## 134.5 Production sidecar stderr (SHIPPED, HS-9565)

**Was a bug, not a decision.** `CommandEvent::Stderr` was `eprintln!`d. On a GUI launch — Dock, Spotlight,
Finder, i.e. how the shipped app is always started — that goes nowhere.

This is the exact hole HS-9557 closed for dev, and it matters for the same reason: a V8/WASM OOM
abort or a native crash **never reaches JS**, so `src/diagnostics/fatalErrors.ts` cannot see it.
Sidecar stderr is the only place it is ever written down.

Routed into the same `~/.hotsheet/server-stderr.log` dev writes. `server_stderr_log_path()` resolves
that one location and `truncate_server_stderr_log()` bounds it once per launch, so the two spawn
paths cannot drift to different files. **No pipe-draining hazard here**, unlike dev: the shell
plugin delivers stderr as channel events, so a slow reader cannot block the child.

**Gotcha for anyone touching this code:** a plain `cargo check` (and `npm run test:rust`) runs the
**dev** profile, so it does not compile `#[cfg(not(debug_assertions))]` at all — it passes happily
while the production path is broken. Use `cargo check --release --manifest-path src-tauri/Cargo.toml`.

Note the release-only `startup_log`'s doc comment claims "dev builds always run from a terminal".
That is **false** for the maintainer, who launches the dev app from the GUI — which is why the Node
side had to persist its own startup log. Worth correcting when this area is touched.

---

## 134.6 The decision: should the shell restart the server?

Everything above restores *visibility*. Restart is a separate question: once the user knows, should
the app fix itself?

### 134.6.1 Options

**A — Never restart (status quo + §134.4/5).** The overlay says what happened; the user quits and
relaunches. Simple, no new failure modes, no risk to the launch path. Costs the user a manual
relaunch and loses whatever they were mid-way through.

**B — Restart on demand.** Add a "Restart Server" button to the overlay. One respawn per click, no
loop, no backoff policy, no timers. The user decides when, so a crash-on-startup bug cannot spin —
they just stop clicking. Still needs the launch-path extraction (§134.6.3), which is the bulk of
the work.

**C — Restart automatically, bounded.** Respawn on unexpected exit with growing delay, capped at N
attempts, then fall through to the overlay saying "restarted N times, still failing". Best outcome
when it works: a transient death becomes a blip the user may not even notice.

### 134.6.2 Trade-offs that actually decide it

- **How often does this happen?** Once, on 2026-08-03, cause unknown. There is no evidence yet of a
  recurring class. Building C for a sample size of one risks solving the wrong shape.
- **A restart is not free of user-visible cost.** The window must `navigate` again, so client
  in-memory state is lost regardless — draft rows, scroll position, open detail panel, terminal
  buffers. B and C differ from A mainly in *who initiates* that reload, not in whether it hurts.
- **C's failure mode is worse than A's.** A wedge-then-SIGKILL loop that restarts into the same
  wedge burns CPU and rewrites the logs that would explain it. The cap bounds it, but the logs are
  the thing most worth protecting after 2026-08-03.
- **B is a strict subset of C.** The extraction, the lock-race question and the renavigate are
  identical; C adds only a policy and a timer. Shipping B first and promoting to C later costs
  almost nothing.

### 134.6.3 What any of B or C requires

1. **Extract the spawn out of `.setup()`** into a function owning: the `Command` build, the
   `SidecarPid` state, the stdout reader (splash handshake + `[lifecycle:progress]`), the stderr
   drain, and the exit branch. This is the risky part — it is the launch path, and a break there is
   a launch hang, the class HS-8704 already cost a debugging cycle.
2. **Verify the lock race.** Dev args include `--replace`. If the death was a wedge the watchdog
   SIGKILLed, the old process may still be releasing the port and project locks.
   `acquireLockWaitingForShutdown` (HS-8706) polls ≤15 s for exactly this, so it is *probably*
   fine — but it was written for relaunch-after-quit, not respawn-after-kill, and must be tested
   rather than assumed.
3. **Renavigate on success.** The page came from the dead process. Reuse the existing
   "running at " / "running instance on port " handshake rather than inventing a second path.
4. **Tell the client what happened.** After a restart the user should see something other than a
   silent reload — at minimum a toast, since their unsaved in-memory state is gone.

---

## 134.7 What must not regress

- **The splash handshake.** `src/launchReadinessContract.test.ts` pins the "running at " /
  "running instance on port " substrings across the TS/Rust boundary. Any extraction must keep both
  matchers on the live path; the test greps the Rust source, so it will catch deletion but **not**
  a matcher moved somewhere it never runs.
- **The quit path.** `ShuttingDown` must still short-circuit before any restart logic, or quitting
  would respawn the server it just drained. This is the single highest-risk interaction in B and C.
- **The watchdog.** Supervision reacts to an exit the watchdog may have *caused*. A restart policy
  must never be able to out-argue the watchdog's SIGKILL — that guard exists so a wedged process
  cannot hold the port and locks forever.
- **The logs.** Restart attempts must not flood or rotate away the `[fatal]` report and stderr tail
  that explain the original death.

---

## 134.8 Testing

The pure pieces are already the testable ones and should stay that way:

- `describe_child_exit` — pure, unit-tested per branch on any host (HS-9558). A signal parameter
  (§134.4) extends the same pattern.
- A backoff/cap policy for C should be a **pure function** of (attempt count, elapsed) → decision,
  unit-tested, with the timer merely executing it — the same shape as `watchdogVerdict` and
  `clusterEviction`.
- The client overlay is covered by `serverExited.test.tsx`; a restart button adds cases there.
- The respawn itself resists unit testing (it spawns a real process). The lock-race question
  (§134.6.3 item 2) is better answered by a **deliberate manual experiment** — SIGKILL the server
  and respawn immediately — recorded in `docs/manual-test-plan.md`.

---

## 134.9 Open decisions

1. **Restart at all, and which option?** A, B, or C (§134.6.1). Recommendation: **B**, promotable
   to C once there is more than one data point. It removes the manual quit-and-relaunch without
   introducing a policy, a timer, or a loop that could fight the watchdog — and it is a strict
   subset of C, so choosing it forecloses nothing.
2. **Does production parity (§134.4, §134.5) block the restart work?** Recommendation: **no, and it
   should ship first** — they are bugs in the shipped app, they are small, and they are independent
   of the extraction.
3. **If C: what cap and what backoff?** Not proposed here, deliberately — the numbers should come
   from an observed failure rate, and there is currently one observation.
4. **Should the restart button (B) also appear for a wedge?** The client cannot currently tell a
   wedge from a network blip, so this would need the shell to report the watchdog's SIGKILL
   distinctly. Probably out of scope; noted so it is not rediscovered.
