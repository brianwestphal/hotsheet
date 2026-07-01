---
name: analyze-code-quality
description: Run all available tests and linters, check for anti-patterns, and generate a comprehensive code quality report
allowed-tools: Read, Grep, Glob, Bash, Agent
---

Analyze the overall quality of the source code in this project. Generate a comprehensive report.

The goal is not just "does it compile and are the lines covered" — it is "is the code *correct in the sequences it actually runs*." A green test suite at 100% line coverage routinely ships behavioral bugs (see step 6). Weight the report accordingly.

## Steps

1. **Run unit tests with coverage**
   ```
   npm test
   ```
   Report: total tests, pass/fail count, coverage percentage by directory.

   Note: `npm test` (vitest) does NOT run the Rust tests. If `src-tauri/` exists, also run `npm run test:rust` (`cargo test` — needs the Rust toolchain) and report those separately. Plugin tests (`plugins/*/src/*.test.ts`) run only when targeted — run `npm run test:all-including-plugins` if you want plugin coverage folded in.

2. **Run E2E tests**
   ```
   npm run test:e2e
   ```
   Report: total E2E tests, pass/fail count. (Use `npm run test:e2e:fast` to skip GitHub-credentialed specs if credentials aren't configured.)

3. **Run linter**
   ```
   npm run lint
   ```
   Report: total errors/warnings, categorized by rule.

4. **Check TypeScript strictness**
   ```
   npx tsc --noEmit
   ```
   Report any type errors.

5. **Check for anti-patterns documented in CLAUDE.md**
   Read `CLAUDE.md` and the `docs/` requirements files first — the authoritative anti-pattern list lives there and evolves, so treat CLAUDE.md as the source of truth over this list. Prefer **ast-grep** for structural checks (`ast-grep run --lang <ts|tsx|rust> -p '<pattern>' <path>`) over text grep — it matches the AST, skipping comments/strings and catching multi-line shapes; pick `--lang` per file extension (`tsx` ≠ `ts` ≠ `rust`). Look for violations of documented conventions, including:
   - Files that are excessively long (check against the code-organization guidelines) or that break **one-primary-export-per-file**.
   - `document.createElement()` instead of `toElement()` from `dom.ts` (note the documented intentional exceptions in CLAUDE.md).
   - New `xxx.innerHTML = yyy` in client code instead of `morph()` / `replaceChildren(toElement(...))` (the `no-restricted-syntax` ESLint rule flags this outside an allowlist).
   - Manual HTML string concatenation instead of JSX/`SafeHtml` (use `raw()` for pre-rendered HTML).
   - Unchecked `as` type assertions where a runtime check belongs — `JSON.parse(x) as Y`, `res.json() as Y` (flagged by `no-restricted-syntax`), and DB JSON-column reads that skip a zod schema. Prefer `instanceof` / type predicates / zod / the `api()` `schema` param.
   - Tauri-unsafe browser APIs in client code (`src/client/**`, `plugins/*/src/**`): `window.confirm/alert/prompt/open` — must use the in-app equivalents (`confirmDialog`, `invoke('open_external_url')`, etc.). These silently no-op in Tauri's WKWebView but pass in Chromium E2E, so they won't show up as test failures.
   - `exec()` instead of `execFile()`/`execFileSync()` for shell commands.
   - Missing `.js` extension on relative import paths (TS ESM convention).
   - Inline `api<{…}>()` literals or raw `api()`/`apiWithSecret()`/`apiUpload()` calls in client code instead of a typed caller from `src/api/`.
   - British spellings in prose / user-visible strings (project standard is American English — see CLAUDE.md for the swap list).
   - `CHANNEL_VERSION` / `EXPECTED_CHANNEL_VERSION` out of sync (must be equal integers).
   - Duplicate code across files.

6. **Behavioral / state-transition audit** — *the anti-false-confidence step.*

   Coverage percentage (step 1) is structurally blind to a **missing state transition**: a bug living in an untested *interaction* between operations sails through a green 100% report, because each individual line still gets hit by isolated, single-operation-from-clean-state tests. Real bugs have shipped this way in stateful modules under 100% line/branch/function/statement coverage. This step exists to catch that class.

   1. **Identify the stateful modules.** Heuristic — flag any source module that has any of:
      - multiple code paths keyed on an internal mode / flag / phase / status,
      - an explicit state machine or lifecycle (init → running → drained → closed, etc.),
      - a cache, memo, or dedup set with a fallback / miss path,
      - a lease / claim / debounce / throttle / single-flight queue,
      - "first run vs subsequent run" / "empty vs populated" branching,
      - accumulated in-memory state mutated across calls (counters, ring buffers, seen-sets, pending maps).

      In this codebase, likely candidates include (verify against current source, names drift): the snapshot/backup lifecycle (`src/db/`), the background scheduler (§75), the WebSocket sync event bus + ring/seq (§93), telemetry ingest rollups / dedup sets (§67, §82, §85), the worker-pool claim/lease/drain state machine (§89–92), terminal lifecycle / active-device lease (§109), reactive stores (`defineStore`, §61), and debounced markdown sync. Don't treat this list as exhaustive — derive it from the actual code.

   2. **For each stateful module, enumerate its states and the transitions between them**, then check whether the test suite exercises the *transitions* — multi-step sequences that cross state boundaries — not just each operation starting from a clean initial state. A test file that only calls each function once from a fresh fixture does NOT cover transitions, even at 100% line coverage.

   3. **Flag any stateful module whose tests are single-operation-from-clean-state only**, and recommend an adversarial **transition-matrix** test for it. Give concrete sequences to try:
      - **out-of-order**: perform operations in an order the happy path never does (release before claim, read before write, resize before attach).
      - **interleaved**: two flows overlapping (two claimants racing a lease; a sync arriving mid-snapshot).
      - **repeated**: the same operation twice with no reset (double-init, double-complete, re-claim, re-enter).
      - **empty-then-refill**: drain to empty, then add again (cache invalidate → miss → repopulate; clear telemetry → re-ingest).
      - **stale / expired**: act on state after a lease/debounce window has elapsed.

   4. If `docs/manual-test-plan.md` exists, cross-check it: features listed there as manual-only that have since become automatable, and stateful features missing from both the automated suite and the manual plan.

## Report Format

Generate a structured report with:
- **Summary**: Overall health (tests passing, lint clean, tsc clean, coverage %) — plus a one-line behavioral-risk verdict.
- **Test Results**: Unit, E2E, and (if applicable) Rust pass rates.
- **Coverage**: By directory, highlighting files below 50%. **State explicitly that coverage % is a floor, not a ceiling** — 100% means every line *ran*, not that every behavior or *sequence* is *asserted*. Use low coverage as a "needs more tests" signal and high coverage as the *trigger* for the behavioral audit below, never as a stopping point.
- **Lint / Type Issues**: Grouped by severity / rule.
- **Anti-Pattern Violations**: Specific files and lines.
- **Behavioral / State-Transition Assessment**: Per stateful module — its states, whether transitions are tested, and for any that aren't, a recommended transition-matrix test with concrete example sequences. This section would flag a stateful module whose transitions are untested *even when its line/branch coverage is at 100%*.
- **Recommendations**: Prioritized list of improvements, with behavioral/transition gaps weighted above cosmetic ones.
