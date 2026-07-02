---
name: prep-major-release
description: Prepare Hot Sheet for a major release — refresh the README so it stays compelling and advertises the most important + newest features, and review the demo scenarios/screenshots, producing a capture-ready plan of which shots to add, recapture, or drop. Use before cutting a major release (or on demand when a lot has shipped).
allowed-tools: Read, Grep, Glob, Bash, Edit, Write, Agent
---

Get Hot Sheet's **public-facing surface** ready for a major release. Two deliverables:

1. **A refreshed `README.md`** — accurate, compelling, and advertising the most
   important + most *interesting* recently-shipped features.
2. **A capture-ready demo-screenshot plan** — which of the `docs/demo-N.png` shots
   to keep, recapture, or add (and any `src/demo.ts` / `scripts/capture-demos.ts`
   changes needed to seed them). The maintainer captures the actual screenshots
   afterward, so end with a clear, reviewed plan — don't try to capture yourself.

The README and the screenshots are the first thing a prospective user sees. A lot
ships between major releases; this skill closes the gap between "what the product
does now" and "what the front page says it does."

**Ground yourself first.** Read `docs/ai/requirements-summary.md` (the Shipped /
Partial / Design-only status of every feature) and `docs/ai/code-summary.md`
before judging what's worth advertising — they're the synthesized source of truth
for what currently exists. Skim the recent `CHANGELOG.md` entries and
`git log --oneline <last-tag>..HEAD` for the headline changes since the last
release. Honor `CLAUDE.md`: **American English**, the project's existing voice, and
the doc-sync rules.

---

## Part A — README review + update

The README lives at `README.md` (~570 lines). Its public sections: the hero +
one-line pitch, **Why Hot Sheet?**, **Features**, **AI Integration** (Claude Code,
Claude Channel, Announcer, Telemetry), **Plugins**, **Backups & Data Safety**,
**Install**, **Usage**, **Architecture**. Screenshots are embedded as
`<img src="docs/demo-N.png" …>` throughout.

1. **Read the whole README**, section by section. For each claim, ask: *is this
   still true, and is it selling the feature as well as it deserves?*

2. **Find what's missing or under-sold.** Cross-reference the README's feature
   coverage against `docs/ai/requirements-summary.md` (every **Shipped** feature)
   and the recent changelog/git history. Build a list of:
   - **New headline features** shipped since the last release that the README
     doesn't mention at all, or buries. Decide which deserve front-page billing
     (the *important + interesting* ones — not an exhaustive dump). Bias toward the
     differentiators: the AI-coding-loop integration (Claude Channel, worklist
     export, MCP tools, distributed workers), the terminal/observability surface,
     Announcer, telemetry/cost tracking, safety (snapshots/backups), plugins.
   - **Stale or wrong claims** — features described that changed or were removed
     (`Design only` / `Deferred` / `REMOVED` items in the summary must not be
     advertised as shipped), wrong limits, dead links, outdated screenshots
     referenced in prose.
   - **Weak framing** — accurate but flat copy that could land harder. Tighten the
     pitch; lead each feature with the user benefit, not the mechanism.

3. **Update `README.md` in place.** Add/rewrite the sections that need it; prune
   genuinely obsolete content; keep it scannable (the existing heading rhythm +
   `<div align="center">` screenshot blocks). Match the current tone — confident,
   concrete, developer-to-developer. Don't pad: a major-release README should be
   *shorter per feature* and higher-signal, not a wall.

4. **Keep the docs in sync** (CLAUDE.md doc-sync rules). If the README references a
   requirements doc, feature name, or limit, make sure it matches the source. The
   `## Hot Sheet - Up Next` block inside the README is generated — don't hand-edit
   it.

5. **Verify every screenshot reference resolves.** For each `docs/demo-N.png` the
   README embeds, confirm the file exists and its `alt`/caption still describes
   what that scenario shows (the captions are read by screen readers and by
   GitHub's text preview). Mismatches feed Part B.

---

## Part B — demo-scenario + screenshot review

The "demo modes" are the `--demo:<N>` scenarios (N = 1–14), defined in
`src/demo.ts` and documented in `docs/8-cli-server.md §8.8` (the scenario table +
per-scenario settings). `scripts/capture-demos.ts` launches each
(`tsx src/cli.ts --demo:N` in a temp dir), performs the scenario-specific in-app
navigation, and writes `docs/demo-N.png` (+ `.svg`). `docs/demo-plan.md` is the
live-demo script (the narrative the screenshots support).

1. **Read the scenario inventory.** `src/demo.ts` (what each scenario seeds +
   scenario-specific settings), `docs/8-cli-server.md §8.8` (the table), and
   `scripts/capture-demos.ts` (how each is navigated + captured). Map every
   scenario → the README image(s) it backs.

2. **Judge each scenario against the current product.** For every scenario decide
   **keep / recapture / drop**, and separately propose **add**:
   - **Recapture** — the feature changed visually since the shot was taken (new
     layout, new chrome, renamed UI), the shot is low-quality/dated, or the README
     caption no longer matches. (A redesigned panel, a new toolbar, a restyled
     board all warrant a fresh capture.)
   - **Add** — a now-shipped headline feature has no demo scenario/screenshot and
     deserves one on the front page (e.g. a major surface that landed since the
     last release). Adding a shot means **adding/seeding a scenario** in
     `src/demo.ts` + wiring its navigation/capture in `scripts/capture-demos.ts`
     (and the §8.8 table) so the maintainer can capture it.
   - **Drop** — a scenario/screenshot that's redundant, off-message, or shows a
     de-emphasized feature. Fewer, stronger shots beat more, weaker ones.

3. **Upgrade `domotion-svg` first if it's behind (HS-9281).** The demos are
   captured *through* `domotion-svg` — `scripts/capture-demos.ts` imports
   `captureElementTree` / `elementTreeToSvg` / `embedRemoteImages` from it to render
   each `docs/demo-N.svg` (and drive the PNG). A stale renderer can produce wrong or
   dated output, so bring it current **before** the capture:
   - Compare the installed version against the registry: `npm view domotion-svg version`
     vs the `devDependencies` pin in `package.json` (or `npm outdated domotion-svg`).
   - If it's behind, upgrade to latest: `npm install domotion-svg@latest --save-dev`.
     (If npm errors with an `EPERM` on the cache, retry with
     `--cache "$TMPDIR/npm-cache-hs"`.) Commit the `package.json` + `package-lock.json`
     bump on its own, then re-run the gates below.
   - Skim `domotion-svg`'s changelog / release notes for the bump range and note any
     capture-affecting change (e.g. an `elementTreeToSvg` output-shape change like the
     HS-8687 / 0.6.0 one already handled in `capture-demos.ts`); adjust
     `capture-demos.ts` if the new version changed its API, and call it out in the
     hand-off so the maintainer knows to recapture through the newer renderer.
   - If it's already current, say so in the report and move on.

4. **Make the code/doc changes needed for capture.** If you propose new or changed
   scenarios, implement the `src/demo.ts` seeding + `scripts/capture-demos.ts`
   navigation + `docs/8-cli-server.md §8.8` table updates **now**, so that when the
   maintainer runs the capture the new shots come out right. Run the gates after
   touching code (or after the `domotion-svg` bump above): `npx tsc --noEmit`,
   `npm run lint`, and `npx vitest run src/demo.test.ts` (the demo seeding has unit
   coverage — keep it green; update it for new scenarios). Do **not** run
   `scripts/capture-demos.ts` yourself to overwrite the PNGs — capture is the
   maintainer's step.

5. **Produce the capture plan** (the hand-off). A per-scenario table:

   | # | Feature | Verdict | Why | Capture command |
   |---|---------|---------|-----|-----------------|
   | … | … | keep / recapture / drop / **add** | one line | `npx tsx scripts/capture-demos.ts <N>` |

   Plus, for any **add/recapture**, the exact README `<img>` block (path + `alt`)
   to use, and a note of which `src/demo.ts` / `capture-demos.ts` changes you made.

---

## Output

End with a concise report:

- **README** — sections rewritten/added/pruned, the new features now advertised,
  and any stale claims removed (with the requirements-summary status that justified
  each).
- **Demos** — whether `domotion-svg` was already current or upgraded (and to what
  version), the capture-plan table (keep/recapture/drop/add), the `src/demo.ts` /
  `scripts/capture-demos.ts` / `docs/8-cli-server.md` changes made, and the gate
  results.
- **Hand-off** — the single command list the maintainer runs to capture the
  add/recapture shots, and a one-line "ready for capture" confirmation.
- **Follow-ups** — file Hot Sheet tickets (per `CLAUDE.md`) for anything out of
  scope: a feature worth a deeper marketing pass, a demo scenario too complex to
  seed now, a doc that needs its own update.

**Before any large or judgment-heavy rewrite** (dropping a whole section, changing
the product's positioning/tagline, removing a flagship screenshot), surface the
proposal to the maintainer rather than committing it unilaterally — a
`FEEDBACK NEEDED:` note on the release ticket (or an `AskUserQuestion`) for the
calls that change how the product presents itself.
