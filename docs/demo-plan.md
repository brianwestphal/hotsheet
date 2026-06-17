# Hot Sheet — Demo Plan

A repeatable, story-driven demo script for showing Hot Sheet (and Glassbox secondarily) to potential users. Built for a **< 30-minute slot including discussion + Q&A** — so the live-driving portion is budgeted at **~18 minutes**, leaving ~10 for reactions and questions.

> This is a maintained doc. When a demoed feature changes name or flow, update the relevant **Act** and the **Feature coverage map** so the script never drifts from the app.

---

## The one-line pitch (say this first, verbatim)

> "Hot Sheet is a local-first project manager that lives inside your repo and hands your tickets straight to Claude Code — your AI does the work, narrates it back to you, and you watch the cost and time add up per ticket."

Everything in the demo is in service of that sentence. If a viewer remembers only one thing, it should be: **tickets in, working software out, with the AI doing the middle and you staying in control.**

## Who you're talking to

Developers who already use (or are curious about) AI coding agents. They feel the pain of: scattered TODOs, no memory between AI sessions, no idea what the AI actually did or what it cost. Frame every feature as an answer to one of those pains.

---

## The spine: "one ticket, end to end — then at scale"

The demo has a single narrative through-line so it's easy to follow and easy to remember:

1. **Act 1 — Capture:** a real piece of work becomes a ticket in seconds.
2. **Act 2 — Execute:** you hand that *one* ticket to Claude and watch it work — terminals, narration, commands.
3. **Act 3 — Account:** you see what that work cost in time and money.
4. **Act 4 — Scale:** the same loop running across *all* your real projects at once (dashboard, cross-project stats, switching).
5. **Act 5 — Trust:** the safety + integration story (GitHub, backups, auto-context) that makes it usable on real work.
6. **Act 6 — Glassbox (secondary):** the same ticket's code gets an AI review.

Pick **one "hero ticket"** before you start (something small but real and visibly useful — a tidy bug fix or a small UI tweak in your primary project). The whole demo follows that hero ticket. Resist the urge to feature-list; let the story carry the features.

---

## Pre-demo checklist (do this 10 minutes before — live demos die on setup)

A smooth demo is 90% prep. Have all of this ready so you never type boilerplate on stage:

- [ ] **Two real projects** already added to Hot Sheet — a **primary** (where the hero ticket lives) and a **secondary** (so "switch projects" and cross-project views have real data). Glassbox itself is a fine secondary.
- [ ] **Backlog seeded** in the primary project: ~6–8 tickets across categories (bug / feature / task / investigation) at varied priorities, so "viewing tickets" looks like real life, not an empty app. Leave **the hero ticket un-started**.
- [ ] **History exists:** at least a few **completed** tickets with notes, and some **telemetry/cost data** already accumulated (run a couple of real tickets the day before) so the **stats pages and per-ticket cost are non-empty**. Empty dashboards are the #1 demo killer.
- [ ] **Announcer** configured and audible — API key set (or local provider), volume up, output device correct. Test it once. The narration is your "wow" moment; a silent Announcer is a wasted beat.
- [ ] **Custom command buttons** defined in the primary project (e.g. `build`, `test`, `lint`) so Act 2 has something to click.
- [ ] **Auto-context** entries set for at least one category and one tag (Settings), so you can *show* them, not just describe them.
- [ ] **GitHub plugin** connected on whichever project you'll show issues sync on.
- [ ] **Terminals quiet but present:** a couple of terminals/PTYs open across projects so the dashboard isn't empty, but nothing mid-output that'll distract.
- [ ] **Window/zoom:** font size bumped, unrelated apps closed, notifications silenced (macOS Focus), and the Hot Sheet window sized so the sidebar + list + detail panel are all visible.
- [ ] **A fallback recording** (short screen capture of the Act 2 "Claude does the ticket" beat) in case live AI is slow or the network is flaky. See *Failure handling* below.

---

## The script

Timings are targets; the **bold** lines are what you click/do, the `>` lines are roughly what you say.

### Act 0 — Hook (1 min)

- Open Hot Sheet on your **primary real project**, already populated.
- > "This is a real project I'm actively working on. Everything you'll see is real tickets and real AI work — no demo sandbox."
- Deliver the one-line pitch. Point out the **`.hotsheet/` folder lives in the repo** — local-first, no cloud account, your data is yours.

### Act 1 — Capture: a ticket in seconds (3 min)

- **Add a project** quickly (or show the "+" / project tabs) — just enough to prove how low-friction onboarding is. Then return to the populated primary so you're not staring at an empty list.
  - > "Adding a project is pointing it at a folder. That's it."
- **Create the hero ticket** live using the fast bullet-list input. Give it a category (e.g. *bug* or *feature*) and a priority.
  - > "The whole point is capture has to be faster than the thought escaping. Type, categorize, done."
- **View / organize:** show the list grouped by status/priority, categories, the detail panel (details, notes, attachments).
- **Star the hero ticket → Up Next.**
  - > "Starring is how I tell both myself *and the AI* what matters right now. 'Up Next' is the AI's work queue."

### Act 2 — Execute: hand it to Claude (6 min — the heart of the demo)

This is the act that sells the product. Slow down here.

- **Kick off the hero ticket in Claude** (the play/▶ action → Claude Channel).
  - > "I didn't write a prompt. The ticket *is* the prompt. Hot Sheet hands Claude the worklist and the context, and it goes."
- **Watch it work — terminals:** show the embedded terminal / the Claude session running. Switch among terminals.
- **Announcer:** turn it on and **let the narration actually play** for a few seconds.
  - > "This is the Announcer — it narrates what the AI is doing, out loud, as it happens. I can step away from the screen and still know where things stand." (This is the most memorable moment — give it air.)
- **Custom command buttons:** click `build` or `test` to show one-click project commands while the AI works.
- **Terminal dashboard:** open the full grid of every terminal across projects; zoom into one.
  - > "When several things are running, this is mission control."
- Let the ticket **complete** (or cut to your fallback recording if it's slow). Show the **completion note** the AI wrote and the ticket flipping to done.

### Act 3 — Account: what did that cost? (2 min)

- On the just-completed hero ticket, show **per-ticket time and cost**.
  - > "Every ticket carries what it actually cost in tokens, dollars, and wall-clock. No more 'I have no idea what the AI spent.'"
- This is a differentiator competitors don't have — name it as such.

### Act 4 — Scale: the same loop, everywhere (3 min)

- **Switch between projects** via the tabs.
  - > "Same workflow, every repo. I live here all day."
- **Single-project stats** ("Claude usage" dashboard) — show charts/sections for the primary project.
- **Cross-project stats** (header-bar page) — the all-projects view.
  - > "Zoom out and it's every project's AI activity, cost, and throughput in one place."

### Act 5 — Trust: safety + integration (3 min)

Pick the 2–3 that resonate most with *this* audience; don't show all of them every time.

- **Auto-context by category / tag** (Settings): show the entries.
  - > "I can attach standing instructions to a *category* or a *tag* — so every 'bug' ticket, or everything tagged `db`, automatically feeds the AI the right context. No re-explaining."
- **GitHub support:** show issues syncing in/out via the GitHub plugin.
  - > "It two-ways with GitHub issues, so it fits a team that already lives there."
- **Backups folder:** show backup setup in Settings.
  - > "Local-first doesn't mean fragile — versioned backups, and it'll even repair a database if it has to."

### Act 6 — Glassbox, the sister tool (2 min, secondary)

- Bring up **Glassbox** and show an **AI code review of the hero ticket's changes**.
  - > "Hot Sheet plans and runs the work; Glassbox reviews it. Same philosophy — local, AI-driven, you stay in control. The ticket you watched get built a minute ago, now gets a second set of (AI) eyes."
- Keep it short — it's the encore, not the headline.

### Close (30 sec) → Q&A (~10 min)

- Recap the spine in one breath: **"Captured a real ticket, handed it to Claude, watched it work and narrate, saw what it cost, and that same loop runs across every project — with GitHub, backups, and review around it."**
- > "It's local, it's yours, and it turns your AI from a chat window into a teammate that works your backlog."
- Open for questions.

---

## Feature coverage map (brain-dump → where it lands)

Every item from the ticket's brain dump, mapped to an act, plus additions:

| Feature | Act | Notes |
|---|---|---|
| Adding a project | 1 | Quick, then back to populated project |
| Creating tickets | 1 | The hero ticket, live |
| Viewing tickets | 1 | List + detail panel |
| Starring / Up Next | 1 | Framed as "the AI's work queue" |
| Kicking off tickets in Claude | 2 | "The ticket is the prompt" |
| Viewing Claude + other terminals | 2 | Embedded terminals |
| Terminal dashboard | 2 | Grid + zoom |
| Switching between projects | 4 | Project tabs |
| Stats (single + cross-project) | 4 | Usage dashboard + header-bar page |
| Time + cost per ticket | 3 | Differentiator — call it out |
| Announcer | 2 | **The wow moment** — let it play |
| Backups folder | 5 | Trust/safety |
| Auto-context by type / tag | 5 | "Standing instructions per category/tag" |
| Custom command buttons | 2 | One-click build/test |
| GitHub support | 5 | Plugin sync |
| **+ Local-first / lives in repo** | 0 | Added — it's the core differentiator |
| **+ Completion notes** | 2 | Added — shows the AI's audit trail |
| **+ Glassbox review** | 6 | Secondary ask |

**Deliberately cut for time** (mention only if asked): drag-and-drop reordering, reader mode, terminal themes/search, OSC shell-integration chips, plugin system internals, MCP tool surface, channel auto-mode. These are depth features — offer them in Q&A, don't spend the 18 minutes on them.

---

## Timing summary

| Act | Content | Target |
|---|---|---|
| 0 | Hook + pitch | 1:00 |
| 1 | Capture | 3:00 |
| 2 | Execute (Claude + Announcer + terminals + commands) | 6:00 |
| 3 | Account (cost/time) | 2:00 |
| 4 | Scale (switch + stats) | 3:00 |
| 5 | Trust (auto-context / GitHub / backups) | 3:00 |
| 6 | Glassbox | 2:00 |
| — | Close | 0:30 |
| — | **Demo subtotal** | **~20:30** |
| — | Q&A / discussion | ~9:00 |
| — | **Total** | **< 30:00** |

### Flex versions

- **15-minute cut:** Acts 0 → 1 → 2 → 3, then one item from Act 5. Drop Act 4 and Glassbox. (The end-to-end story still lands.)
- **45-minute version:** add the depth features from the "cut" list as a guided tour after Act 6, and let people drive.
- **If the audience is non-technical / buyers:** linger on Act 3 (cost), Act 4 (stats), and Act 5 (GitHub/backups); shorten the terminal-heavy parts of Act 2.

---

## Failure handling (rehearse the recovery, not just the happy path)

- **Live AI is slow / network flaky:** cut to your pre-recorded Act 2 clip, narrate over it, and continue. Never wait in silence for a model.
- **Announcer silent:** have it pre-tested; if it fails live, say "it narrates this out loud — I'll show you after" and move on rather than debugging on stage.
- **Empty dashboards:** this is why the pre-demo checklist seeds history. If you're forced onto a fresh machine, *say so* and show the shape of the UI instead of pretending there's data.
- **Something errors:** Hot Sheet is local and real — a hiccup is on-brand ("this is my actual working project"). Acknowledge, recover, keep the arc moving. Don't rabbit-hole into a fix.

---

## Q&A prep (anticipate these)

- **"Where does my data live? Is it private?"** → Local, in `.hotsheet/` in your repo. No cloud account required. (Lead with this — it's the top concern.)
- **"What does it cost to run?"** → It's the AI usage cost; Hot Sheet *shows* you that cost per ticket so there are no surprises (tie back to Act 3).
- **"Does it work with my AI / editor?"** → It's built around Claude Code via the Channel + MCP tools; the worklist is plain markdown any tool can read.
- **"Team use / multiplayer?"** → Today it's local-first single-user with GitHub issue sync as the team bridge; be honest about where collaboration is vs. isn't.
- **"What if the AI does the wrong thing?"** → You approve/permission actions, every ticket has an audit trail of notes, and Glassbox reviews the diff. You stay in control.
- **"Can I use it without the AI parts?"** → Yes — it's a fast local ticket tracker on its own; the AI loop is additive.

---

## Assumptions baked into this script (tweak before demoing)

- You'll demo on your **own real projects**; Glassbox doubles as the secondary project.
- The audience is **technical** (developers). If not, use the non-technical flex note above.
- Announcer + telemetry/cost + GitHub are all **configured and populated** ahead of time (see checklist). If any isn't, either set it up beforehand or drop that beat rather than configuring live.
