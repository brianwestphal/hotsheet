# 131. System memory pressure

HS-9469. Status: **shipped.** Extends the [128-cluster-cache-bounding.md](128-cluster-cache-bounding.md)
cluster budget with the *machine's* memory pressure, not just this process's heap headroom.

## 131.1 Why process headroom is only half the answer

[docs/128 §128.2.1](128-cluster-cache-bounding.md) sizes the PGLite cluster cache from
`process.memoryUsage().external` against `v8.getHeapStatistics().heap_size_limit`. That is
exactly right for the failure it was built for — the 2026-07-24 crash loop was V8's own ceiling
— and it is free and synchronous.

It is also blind to the rest of the computer. If the machine is swapping because of Xcode, a
VM, or a browser with 200 tabs, Hot Sheet holds ten clusters open because *its* headroom looks
fine, and makes the problem worse. The maintainer's ask was to "keep more in memory when
pressure is low and less when it's high"; process headroom answers that question about the
process, not about the machine the user is actually using.

## 131.2 A level, not a number

`systemMemoryPressure.ts` reports `normal | warn | critical`, because bytes do not mean the same
thing across platforms and the OS already knows the answer better than we can compute it.

| Platform | Signal | Why |
| --- | --- | --- |
| macOS | `sysctl -n kern.memorystatus_vm_pressure_level` → 1 / 2 / 4 | the kernel's own verdict; nothing we compute from page counts beats it |
| Linux | `/proc/pressure/memory`, `some avg10` | PSI measures **stall time**. A machine can have little free memory and be perfectly happy, but it cannot be stalling and be happy |
| Windows / other | free/total ratio | no cheap kernel verdict available; deliberately generous (see below) |

An unrecognized *higher* macOS level is treated as `critical` rather than ignored — fail toward
caution.

## 131.3 Why `os.freemem()` is the fallback and not the implementation

It is portable, free, and wrong. On macOS "free" excludes purgeable and file-backed pages, so a
healthy machine reports a small fraction free.

**Measured on this machine while writing this, with the kernel reporting `normal`:**

```
sysctl -n kern.memorystatus_vm_pressure_level → 1   (normal)
os.freemem() / os.totalmem()                  → 0.9 GB / 32.0 GB  (2.8% free)
```

A naive free-ratio threshold would have called that `warn` and shrunk the cache on a machine
the kernel considered completely fine. That is why the ratio thresholds are set where they are
(`≤8%` warn, `≤2%` critical) — low enough that a false alarm is unlikely on the platforms where
it is the only signal available.

## 131.4 React fast, relax slowly

Two rules keep the signal from becoming a source of churn:

- **Sampled, never polled hot.** The budget is recomputed on every cluster open and every sweep.
  `currentSystemPressure()` returns the last sample and kicks off a refresh in the background
  when it is older than `SAMPLE_TTL_MS` (15 s). It is synchronous and never awaits the probe —
  an eviction decision must not wait on a subprocess. Acting on a reading up to one TTL old is
  far cheaper than blocking.
- **Asymmetric hysteresis.** An *increase* in pressure is adopted immediately; a *decrease* must
  survive `EASE_SAMPLES` (3) consecutive calmer readings. Pressure is spiky, and following every
  dip back down would reopen clusters about to be evicted again — churn, during exactly the
  period when reopens are most expensive. Being slow to relax costs a little cache; being quick
  to relax costs thrashing. (`evictChurn`, §128.5.2, is what would show it.)

**A failed or timed-out probe reports `normal`**, i.e. adds no constraint and leaves the
process-level guard exactly as it was. Shrinking the cache because we failed to *measure* would
be the worst available failure mode.

## 131.5 How it folds into the budget

The level is passed **into** `clusterBudget` as a value, never read inside it, so the planner
stays pure and the whole matrix is testable without a real machine under load.

```
allowedTotal = clamp(openNow + spare, floors, ceilings)   // process-level (§128.2.1)
constrained  = applySystemPressure(allowedTotal, floorTotal, level)
```

- `normal` — no change.
- `warn` — halve the room **above the floors** (not the total), so the floors keep their meaning.
- `critical` — drop to the floors outright. At that point the machine is stalling and holding
  cache is actively harmful.

It is a **ceiling on** the process-derived budget, never a license to grow: if either signal
says memory is tight, memory is tight. A test pins that `normal` cannot loosen a budget the
process term already tightened. The §128.3 invariants are untouched — never evict mid-query,
never evict a pinned cluster, `defaultDbPath` always pinned, floors always honored.

## 131.6 Known gaps

- **Windows has no real signal.** It uses the free-ratio fallback, which is better than nothing
  but is not a pressure verdict. `GlobalMemoryStatusEx` would need a native call.
- **The macOS probe is a subprocess.** Cheap at one per 15 s, but not free. If Hot Sheet ever
  gains a native module for another reason, reading the sysctl directly would be strictly better.
- **The thresholds are reasoned, not tuned.** Linux PSI ≥5% / ≥20% and the free-ratio cutoffs
  are first-principles choices. §128.5.2's `evictChurn` counter is the instrument for revisiting
  them with evidence.

## 131.7 The probe imports `child_process` lazily (HS-9498)

`sampleSystemPressure` resolves `child_process` **inside** the macOS branch, through
`utils/execAsync.ts`, rather than `promisify(exec)` at module scope.

Module-scope `promisify` of a `child_process` export makes a module hostile to import:
`promisify(undefined)` throws, so any test that PARTIALLY mocks `child_process` — for
its own unrelated reasons, naming only the exports it uses — dies during module
evaluation the moment this file appears anywhere in its dependency graph. It got there
transitively via the docs/128 eviction path and took down `routes/dashboard.test.ts`
and `routes/shell.test.ts` **entirely**, from 2026-07-27 until HS-9498.

Two things make this worth a section rather than a code comment:

- **It had already happened once**, to `git/status.ts` (HS-8723), and was fixed by
  adding the missing export to the one mock that noticed. Per-mock fixes do not hold —
  every future test that mocks `child_process` inherits the trap and finds out by
  tripping over it. All seven modules that shell out now share
  `utils/execAsync.ts`, and `utils/lazyChildProcessImport.test.ts` imports each of them
  under a partial mock so a regression fails in a file whose name says why.
- **The lazy form is also more correct here.** It moves the failure inside the `try`,
  where a missing export degrades to `normal` — which is this module's whole contract
  (§131.4): a probe we cannot run adds no constraint. Failing to *measure* pressure must
  never shrink the cache. Under the old form, an unmeasurable probe was a crash.

Cost is one `await import()` per sample against an already-cached module, at most once
per `SAMPLE_TTL_MS` (15 s), on a path that is already spawning `sysctl`.

## 131.8 Cross-references

- [128-cluster-cache-bounding.md](128-cluster-cache-bounding.md) §128.2.1 (the budget this
  constrains), §128.5.1 (the GC-lag trap that applies to any pressure source), §128.5.2 (the
  eviction counters that would show this misbehaving).
- HS-9421 — the `external` diagnostics that made the original OOM visible.
