# 105. Provisioning `node_modules` into Worker Worktrees

**Status: PARTIAL** — the core **`provisionNodeModules` helper SHIPPED (HS-9087,
2026-06-26)**; wiring it into `createWorktree` (HS-9088) + the per-project
worktree-setup hook (HS-9089) remain. Implementation follow-up to the
HS-9047 investigation. Today `createWorktree` (`src/worktrees.ts`) does
`git worktree add` + the follower pointer + channel/skills wiring but **no
dependency setup** — so every fresh worker worktree starts with an empty
(gitignored) `node_modules` and must `npm ci` from scratch before any gate (tsc /
lint / test) runs (~18 s here, minutes on bigger repos, × N workers). This
designs efficient provisioning + a general per-project worktree-setup hook. The
provisioning helper is **shared** with the §99 worktree-refresh routine (HS-9063).

## 105.0 Goal

A fresh worker worktree should be ready to build in **near-zero** time, with
graceful degradation across filesystems, and the install logic should live in
**one reusable helper** called at both worktree creation (this doc) and periodic
refresh ([99-worker-worktree-refresh.md](99-worker-worktree-refresh.md) step 3).

## 105.1 Efficient `node_modules` provisioning

A **best-effort, non-blocking** step in `createWorktree` (after `git worktree
add`), with a degradation ladder:

1. **Preferred — copy-on-write clone** of the owner's `node_modules`:
   `cp -c <owner>/node_modules <worktree>/node_modules` (macOS APFS) /
   `cp --reflink=auto …` (Linux Btrfs/XFS). Near-instant, zero extra disk until
   modified, and each worktree gets its **own isolated** `node_modules` (safe to
   `npm ci` later if its branch changes deps). Native deps
   (`@electric-sql/pglite`, `node-pty`) copy fine — same machine / same ABI.
2. **Fallback — symlink** `node_modules` → the owner's, when reflink isn't
   supported / fails. Instant + shared; native `.node` work at runtime
   (read-only). Caveat: a branch that changes `package.json`/lock needs a real
   install (it shares the owner's deps until then).
3. **Final fallback — `npm ci`** when the owner has no `node_modules` to clone.
4. **Correctness guard (the lock-diff reconcile)** — if the worktree's
   `package-lock.json` differs from what was provisioned (the worker's branch
   changed deps), run `npm ci` to reconcile. This is the same guard the §99
   refresh runs after a rebase that touched the lock — so a worktree never builds
   against the wrong deps (silently green-but-wrong).

### Platform note (per memory: macOS tech → cover Linux + Windows)

- **macOS (APFS):** `cp -c` (clonefile) → CoW.
- **Linux (Btrfs/XFS/overlay):** `cp --reflink=auto` → CoW where the FS supports
  it, silently a normal copy where it doesn't (so still correct, just not free).
- **Windows:** no portable CoW for `node_modules`; reflink/`cp -c` are absent.
  Degrade to a **junction/symlink** (`mklink /J`) where dev-mode/permitted, else
  **`npm ci`**. Detect capability by **trying** the CoW command and falling back
  on error (don't sniff the FS), so the ladder is uniform across platforms.

## 105.2 Shared provisioning helper (the key factoring) — **SHIPPED (HS-9087)**

**What shipped:** `src/workers/provisionNodeModules.ts` —
`provisionNodeModules(worktreeRoot, ownerRoot, opts?)` → `ProvisionResult { ok,
strategy: 'cow'|'symlink'|'npm-ci'|'already-present'|'skipped', reconciled, detail? }`.
The ladder: CoW (`cp -cR` on darwin / `cp --reflink=auto -R` on linux, via the
injectable `CmdRunner`; Windows/unknown skip straight to the next rung) → symlink
(`fs.symlinkSync`, `'junction'` on Windows else `'dir'`) → `npm ci` (owner has no
deps / symlink failed). Then the **lock-diff reconcile**: when the worktree's
`package-lock.json` differs from the owner's, run `npm ci` (skipped after a fresh
`npm ci`; a symlink is `rmSync`'d first so the install lands in the worktree, not
the owner). CoW is detected by **trying the command** and verifying `node_modules`
exists, falling back on any error — no FS sniffing. The heavy `cp`/`npm` commands go
through `CmdRunner` (default `defaultCmdRunner` shells via `execFile`); the symlink +
lock reads use real `fs`. Consumed by **`createWorktree` (HS-9088)** + the **§99
`refreshWorktree` step 3 (HS-9074)** — same reconcile path, no duplication. Tests:
`src/workers/provisionNodeModules.test.ts` (9, real temp dirs: each rung forced by
the injected runner + platform, reconcile vs skip, already-present/refresh path,
failing-`npm ci`). Original design:

Per the HS-9057 note: factor the ladder (CoW clone → symlink → `npm ci`, incl. the
§105.1.4 lock-diff reconcile) as **one reusable helper**, e.g.
`provisionNodeModules(worktreeRoot, ownerRoot, opts)` returning a structured
result (which strategy ran, whether a reconcile install happened). Call it from:

- **`createWorktree`** (this doc) — initial provisioning.
- **§99 `refreshWorktree` step 3** (HS-9063) — the post-rebase conditional
  reinstall reuses the **same** reconcile path, so the install logic isn't
  duplicated across the two call sites.

Keep it injectable (a runner seam like `worktrees.ts`'s `GitRunner`) so it's
testable against a real temp dir without real npm where possible.

## 105.3 General per-project worktree-setup hook

Some repos need more than npm install (`.env` files, codegen / `prisma generate`,
a build step). Add a **configurable per-project setup command** run after the
`node_modules` step, best-effort + logged:

- A `worktreeSetup` **setting** (a shell command string), and/or a
  `.hotsheet/worktree-setup.sh` **convention** Hot Sheet runs if present.
- Runs after provisioning, in the worktree dir, with the worktree root as cwd.
- **Best-effort + logged** — a setup hiccup must never fail worktree creation
  (same contract as the existing channel/skills wiring).

This keeps the `node_modules` special-case fast (it's the common, hot path) while
covering arbitrary per-project setup generically.

## 105.4 Non-blocking / lifecycle

- The npm/CoW work must **not block** the worktree-create API response — run it
  async (or let the worker wait on its first build). The HS-9047 note + the
  channel/skills wiring already establish "best-effort, never fail create."
- The `/hotsheet-worker` skill (or a small setup check) detects the lock diff
  before its first build and reconciles (the §105.1.4 guard) — so even if the
  async provisioning is mid-flight, the worker's first gate run is correct.

## 105.5 Open questions

- **CoW detection** — confirmed approach: try-and-fallback (run `cp -c` /
  `--reflink=auto`, catch failure), not FS sniffing. Validate the exact flags +
  error signatures per platform during implementation.
- **Symlink correctness over time** — a symlinked worktree shares the owner's
  deps; the lock-diff reconcile must convert it to a real install when the
  branch changes deps (can't `npm ci` into a symlink pointing at the owner —
  replace the symlink first). Spell this out in the helper.
- **Hook security** — `worktreeSetup` runs an arbitrary shell command from
  project config; it's the maintainer's own repo (same trust level as
  `.hotsheet/` already has), but note it. The `.hotsheet/worktree-setup.sh`
  convention is gitignored-local, the setting is shared — classify per §95.
- **Windows junctions** — confirm `mklink /J` works for the worker use case or
  fall straight to `npm ci` there.

## 105.6 Tests

Real temp-repo tests (mirror `worktrees.test.ts`):
- Provisioning picks **symlink / copy / ci** by availability (force each branch).
- The **lock-diff reconcile** path: a worktree whose lock differs from the
  provisioned one triggers `npm ci`; an identical lock skips it.
- The **worktree-setup hook** runs after provisioning, best-effort (a failing
  hook logs but doesn't fail create).
- Shared-helper parity: the same helper called from the §99 refresh path produces
  the same reconcile decision.

## 105.7 Follow-up tickets

- **`provisionNodeModules` shared helper** (CoW → symlink → `npm ci` + lock-diff
  reconcile, platform-laddered, injectable) — **the core**; consumed by both
  `createWorktree` and §99 `refreshWorktree` (HS-9074).
- **Wire it into `createWorktree`** (non-blocking, best-effort) (§105.1, §105.4).
- **Per-project worktree-setup hook** (`worktreeSetup` setting +
  `.hotsheet/worktree-setup.sh` convention) (§105.3), classified per §95.
- Relates: HS-9047 (investigation), HS-9063/§99 (shared refresh consumer),
  §95 (setting classification).
