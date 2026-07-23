---
name: feature-health
description: Re-assess every Hot Sheet feature for whether it ACTUALLY WORKS (verified / unverified / broken) and rewrite docs/feature-health.md. Use periodically, before a release, or when asked "what's underbaked / half-baked / not working?"
allowed-tools: Read, Grep, Glob, Bash, Edit, Write
---

Rebuild [`docs/feature-health.md`](../../../docs/feature-health.md) from current evidence.

## The question this answers

**Does each feature actually work?** — NOT "was it built?"

`docs/ai/requirements-summary.md` already tracks built-ness (Shipped / Partial / Design only). This
skill tracks **trustworthiness**. A feature can be 100% Shipped there and `Unknown` here (built,
never realistically exercised). That gap is the entire point.

**Enhancements are out of scope.** Every feature could do more; saying so is noise. A note earns its
place ONLY if it records:

- missing **core** functionality (the feature can't do its stated job),
- a **known bug** or a burst of fix commits,
- an **unsettled decision** the feature is resting on,
- **absent verification** (no automated coverage AND no evidence of real use).

A feature with nothing wrong gets **no note**. Resist the urge to fill every cell.

## Method

Work from evidence, in this order of weight. Don't skip to conclusions from the docs — the docs have
been wrong in both directions before.

1. **Enumerate the features.** Use `CLAUDE.md`'s requirements-doc list (§1–§N) as the spine, then
   merge doc numbers into coherent user-facing features. Also sweep for features with no doc
   (check `src/client/` modules and the settings dialog tabs). Keep the existing table's grouping
   unless the product has genuinely changed shape.

2. **Map automated coverage.** `ls e2e/*.spec.ts` and `find src plugins -name '*.test.ts'`. For each
   feature ask: is there a spec that drives the **real user flow**?
   - **Open the spec and read its test names** before crediting it. A spec that only asserts empty
     states, disabled controls, or button visibility does NOT cover the feature —
     `e2e/worker-pool.spec.ts` is the canonical example of this trap.
   - Specs that need credentials (GitHub sync) or are excluded from `test:fast` are weaker evidence.

3. **Find where the bugs currently are.** `git log --oneline -200 --format='%s'`. A cluster of fix
   commits on a feature that shipped in the last ~2 weeks ⇒ **Shaking out**. Check dates with
   `git log -1 --format=%as -- <path>` when unsure.

4. **Read the open backlog.** Query Hot Sheet for open + backlog tickets (the `hotsheet_query_tickets`
   MCP tool, `status equals not_started` / `backlog`, `logic: any`). Look specifically for:
   - "decide whether to …" tickets ⇒ the feature is resting on an **unsettled decision** ⇒ Underbaked
     regardless of code completeness;
   - known-broken reports;
   - deferred sub-tickets that leave a footgun (e.g. HS-8923, the `--test` keychain sharing).

5. **Identify manual-only surfaces.** Anything unverifiable by automation — Tauri desktop, keychain
   backends, real AI agents, exposed `--bind`, OS clipboard, native notifications. `docs/manual-test-plan.md`
   is the catalog. Note that **its checkboxes are never ticked**, so it proves what *can't* be
   automated, never what *was* verified.

6. **Diff advertisements against implementations.** Docs and type unions routinely promise more than
   the code delivers. Two confirmed instances to re-check every run, plus look for new ones:
   - `src/plugins/types.ts` `PluginUIElement` union vs what `src/client/pluginUI.tsx` actually renders;
   - the `ai_tool` dropdown options in `src/routes/pages.tsx` vs the agents with a real drive.
   `ast-grep` is the right tool for these structural diffs.

7. **Weigh dogfooding.** Anything exercised constantly by running Hot Sheet on Hot Sheet (tickets,
   terminals, channel, commands, settings) has strong real-world evidence even where tests are thin.
   A telemetry dashboard, `--demo`, or `--test` does not get this credit.

## Assigning a status

Use the vocabulary already in the doc — **Solid / Solid\* / Shaking out / Underbaked / Incomplete /
Unknown / Not built** — and keep the definitions table intact.

Two calibration rules that matter more than the definitions:

- **Absence of evidence is `Unknown`, not `Solid`.** If nothing shows a feature has ever been run for
  real, say so. Do not assume it works because it compiles and has unit tests.
- **`Underbaked` is about trust, not completeness.** A fully-built feature with an open "should we
  keep this?" ticket, a wrong default, or an unsettled model underneath it is Underbaked.

## Writing the doc

1. **Rewrite `docs/feature-health.md` wholesale** — this is a snapshot, not an accreting log. Update
   the snapshot date at the top to today.
2. Recount the **Dashboard** table from the rows you actually wrote (don't carry old numbers forward).
3. Refresh the **shortlist** — the 5–8 things worth fixing or verifying first, ordered by how much
   risk they carry. Structural problems that will recur (like the project-switch reset class) outrank
   one-off gaps.
4. Keep the **"How this assessment is made"** section current: if you discover a new evidence source
   or a new advertise-vs-implement trap, add it there so the next run inherits it.
5. Cite specifics — ticket ids, file paths, spec names, commit counts. A note a reader can't verify
   is worth little.

## Afterwards

- **Report the deltas** since the last snapshot: what improved, what regressed, what's newly Shaking
  out. That change-over-time signal is the main reason to run this repeatedly.
- **File tickets for concrete defects** you confirm along the way (per `CLAUDE.md`, file them, don't
  ask first) and reference them in the notes.
- Do NOT file tickets for things that are merely `Unknown` — the fix for those is verification, so
  prefer one ticket per *area* to actually exercise it, rather than noise.
- Run `npx tsc --noEmit` / `npm run lint` only if you changed code; a docs-only run needs neither.
