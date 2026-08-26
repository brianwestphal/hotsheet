---
name: ui-ux-review
description: Ruthless Principal-Designer UI/UX review of a Hot Sheet surface — an app screen/flow (list & column views, detail panel, settings, terminal drawer, dashboards, dialogs) or the README (as rendered markdown). Reviews across four heuristic categories, gets an independent second opinion and reconciles, and files Hot Sheet tickets for the findings.
---

# ui-ux-review — a repeatable, ruthless UI/UX review

Use this when the maintainer asks to "review the UI/UX" of a surface, or after
changing a user-facing surface, or when reviewing "our screens / flows /
operations." It applies one fixed review lens, gets a second independent
opinion, reconciles the two, and turns findings into Hot Sheet tickets.
Established for kerf as KF-536; ported to Hot Sheet under HS-9712.

## The surfaces Hot Sheet has (pick the ones in scope)

Hot Sheet is a **real app**, so most surfaces are live screens/flows, not
documents. Scope each review to a named screen or flow.

- **The app UI** — the main surfaces a user actually touches:
  - **List view** + **column/kanban view** (`src/client/ticketList.tsx`,
    `columnView.tsx`) — the primary work surface, including the new-ticket draft
    row, batch/multi-select toolbar, drag targets, sort/search controls, empty
    states, and the row indicators (up-next star, blocked/feedback borders, unread dot).
  - **Detail panel** (`detail.tsx`) — side/bottom layouts, notes, attachments,
    feedback dialog, reader mode, blocked-reason editor, auto-save.
  - **Sidebar** (`sidebar.tsx`) — status views, category/priority filters, custom
    views, stats bar, command groups.
  - **Settings dialog** — its tabs (General, Categories, Backups, Context, Plugins,
    Terminal, Permissions, API Keys, Telemetry, Announcer, Experimental, Updates).
  - **Terminal drawer + terminal dashboard** (`terminalDrawer*`, `terminalDashboard*`).
  - **Dashboards** — the per-project analytics/telemetry sections and the
    cross-project stats page.
  - **Cross-cutting overlays** — permission overlay, quit-confirm, feedback dialog,
    upgrade nudge, toasts, context menus, project tabs.
- **`README.md`** — the most important marketing surface. **Review it as it renders
  on GitHub and npm** (GitHub-flavored markdown), i.e. as a landing page, within
  the bounds of what that markdown allows: headings, lists, tables, fenced code,
  images/badges (`docs/demo-N.png`), blockquotes, one centered HTML block at the
  top; no custom CSS/JS. Treat the rendered README like any other UI.

A full-app sweep is many reviews; do them one screen/flow at a time and say what
you covered. `docs/4-user-interface.md` is the map of what each screen is supposed
to do — read the relevant section before reviewing that screen.

## How to actually SEE the surface

- **App screens/flows** — you need real pixels + DOM. In order of preference:
  1. **A live look via the `claude-in-chrome` skill** against the running app at
     `http://localhost:4174` (screenshot + DOM + console). **Read-only**: never
     create/delete/edit the maintainer's real tickets, never force-quit their
     instance (they use it for live work — see the standing rules in memory).
  2. **An isolated instance** for anything that needs seeding or clicking: launch
     with `--demo` (representative seed data) and/or `--test` / `HOTSHEET_HOME`
     (isolated data dir, docs/87) so you never touch the maintainer's data. Then
     drive it with `claude-in-chrome` or the `run` skill.
  3. **The Playwright e2e harness** (`e2e/`, temp data dir) for scripted captures
     of a specific flow when a one-off manual instance is awkward.
  If you genuinely can't render it, review the component + SCSS source and **say**
  the review is source-only (structure/copy/interaction contract, not pixel-level).
- **README / markdown**: read the source; reason about the rendered result. Heading
  tree, list density, code-block length, table width, image **alt text**, link
  labels, and scan order are all inspectable from source. Cross-check the embedded
  `docs/demo-N.png` references resolve and show a current screen.

Hot Sheet is a **desktop** app (Tauri WKWebView + browser), not mobile: weigh
pointer target size, keyboard navigation, focus-visible states, and hover/drag
affordances over the lens's mobile tap-target metric. Flows must also behave the
same in **both** the browser and the Tauri build (Tauri silently no-ops several
web dialog/navigation APIs — see `CLAUDE.md` § Tauri-unsafe browser APIs), so
flag any flow that would break in the desktop build even if it works in Chromium.

## The review lens (use this prompt verbatim as the standard)

> Act as a ruthless, elite Principal Product Designer and UX Researcher. Review
> the interface. Evaluate the design strictly using industry heuristics,
> human-computer interaction principles, and modern design systems. Do not just
> praise the aesthetic — provide deep, critical feedback across these exact
> categories:
>
> - **Visual Hierarchy & Layout**: focal points, grid alignment, whitespace,
>   scanning patterns (F-pattern or Z-pattern), and whether primary actions stand
>   out from secondary elements.
> - **UX Friction & Cognitive Load**: unnecessary steps, confusing user flows,
>   ambiguous icons, hidden navigation, or cognitive overload on this screen.
> - **Accessibility (a11y) & Readability**: contrast ratios (WCAG), tap target
>   sizes (min 48×48px on mobile), font sizing/scaling, text legibility.
> - **Microcopy & Content Strategy**: button labels (CTAs), helper text, empty
>   state messaging, error states — clarity, tone, actionability.
>
> Format the response: **The Good** (what works, keep it) · **Critical Issues**
> (ranked highest→lowest severity by user impact) · **Actionable Recommendations**
> (specific, practical fixes — no guessing).

For a **markdown/README** target, map the categories onto what markdown controls:
hierarchy = heading tree + section order + first-screenful hook; friction = value-
prop clarity, wall-of-text, over-long code samples, redundancy, a clear
install→first-run→docs path; a11y/readability = image **alt text**, link-label
clarity (no bare URLs / "click here"), reading level, meaning-survives-if-images-
don't-load; microcopy = the tagline, headings-as-CTAs, feature bullets, install copy.

## Workflow

1. **Name the surface/flow** in scope and how you'll view it (live / isolated
   instance / source-only).
2. **Do your own review** with the lens above. Be concrete — cite exact screens,
   components, or README lines, not vibes.
3. **Get a second, independent opinion and compare notes.** The maintainer's
   process asks for a cross-check ("ask codex and compare notes"). Do whichever
   is available:
   - If the environment has a **codex** (or other second model) tool, ask it the
     same prompt on the same surface.
   - Otherwise spawn a **fresh general-purpose subagent** (`Agent`, NOT a fork —
     you want an independent view) with the verbatim lens on the same surface, and
     reconcile. Note in the writeup which second-opinion source you used.
   Reconcile: keep findings both raise (high confidence), weigh disagreements on
   merit (don't average — judge), and drop anything neither the evidence nor the
   second reviewer supports.
4. **Write the synthesis** in the exact format: **The Good · Critical Issues
   (ranked) · Actionable Recommendations**. Where the two reviews disagreed, say so.
5. **File Hot Sheet tickets** for the critical issues and the actionable
   recommendations — prefer the `hotsheet_*` MCP tools (or the `hs-bug` / `hs-task`
   / `hs-issue` skills). Reference "Surfaced by /ui-ux-review on YYYY-MM-DD" + the
   surface in the ticket. Group tightly-related fixes into one ticket; keep
   genuinely separable ones apart so they can be prioritized. **If a fix is a
   judgment/taste/brand call you're unsure about, file the ticket and add a
   `FEEDBACK NEEDED:` note asking the maintainer before implementing.**
6. **Don't implement in this pass** unless the maintainer said to — this skill
   produces the review + tickets. (When later asked to *apply* a specific
   recommendation, do it under its ticket and re-review the result.)

## Hard rules

- **No bare `HS-NNNN` markers on any published surface** (README, `docs/**`, other
  out-of-DB prose). Per `CLAUDE.md` § "Ticket numbers in prose": never tell a
  reader to look in `.hotsheet/` (it's local-only), and if a number must appear,
  pair it with a short self-contained summary. Published copy is self-contained prose.
- **American English** in all review copy and any edits (`CLAUDE.md` § Spelling).
- **Don't overclaim.** Before praising or advertising a feature, cross-check
  `docs/feature-health.md` (does it actually work? — Solid / Shaking out /
  Underbaked / Incomplete) and `docs/ai/requirements-summary.md` (Shipped vs
  Design-only vs Deferred). Never let review copy present a design-only or
  underbaked feature as shipped, and don't invent numbers/limits.
- **Never disrupt the maintainer's live instance.** Read-only on `localhost:4174`;
  use `--demo` / `--test` / an e2e temp dir for anything interactive. Don't
  force-quit their app or mutate their real tickets.
- **Concerns → tickets.** Findings become Hot Sheet tickets, not silent edits.
