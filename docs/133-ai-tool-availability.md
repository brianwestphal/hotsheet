# 133. AI-tool availability and enablement — what ships, and what a user opted into

HS-9517. Status: **shipped (2026-07-31)**.

AI tools are **opt-in**, like [docs/18](18-plugins.md)'s bundled GitHub plugin: known and
built into the app, but not enabled until the user chooses one. **Claude, and only Claude,
is enabled by default.**

This doc owns the *shipping and opt-in* model. The plugin contract those tools implement
is [docs/132](132-ai-tool-plugin-interface.md); the per-tool integrations are
[docs/113](113-multi-ai-tool-support.md) and its children.

## 133.1 Two questions, deliberately separate

The mistake this design corrects was treating one question as two, and then as one again.

| | Question | Answer lives in | Varies by |
|---|---|---|---|
| **Availability** | Is this integration shipped at all? | `AiToolPlugin.maturity` | nothing — it is the same on every machine |
| **Enablement** | Has the user opted into it here? | per-project `ai_tool_enabled:<id>` | project |

[docs/124](124-in-development-gates.md)'s five `dev_tool_*` gates fused them: a per-project
runtime flag stood in for "we haven't finished this yet". That is not a per-project fact,
and the mismatch produced a real defect (HS-9515) — the `ai_tool` dropdown kept a gated
tool selectable when a project already used it, while `applyDevFeatureGates` hid that
tool's settings unconditionally, so a project could show Codex selected with **no way to
configure it**.

Separating them is what allows Codex to ship publicly as **beta** while Gemini and Goose —
which have no working drive — stay out of users' hands entirely.

## 133.2 Maturity

`AiToolPlugin.maturity`, declared in `src/aiTools/plugins/<id>.ts`:

| Value | Meaning | Listed in Settings → AI tools? |
|---|---|---|
| `stable` | Shipped and trusted. | yes |
| `beta` | Shipped and working, still settling. Badged **BETA**. | yes |
| `unreleased` | **Not shipped.** Untested; may not work at all. | only behind the Experimental gate |

Current declarations — and these are asserted by `enablement.test.ts`, so the shipping
decision cannot drift silently:

- **Claude** `stable` · **Codex** `beta`
- **Antigravity / OpenCode / Gemini / Goose** `unreleased` — Gemini has no drive
  transport at all and Goose is unimplemented beyond command resolution, so shipping
  either would put a play button in front of users that cannot work
  ([feature-health.md](feature-health.md)).
- **Cursor / Copilot / Windsurf** `stable` — Tier-B editor tools; they only receive
  generated rules/instructions, a shipped and tested path.

Maturity is meant to track [feature-health.md](feature-health.md)'s assessment rather than
run ahead of it. Promoting a tool means editing one line in its plugin.

## 133.3 Enablement

Per-project, stored in the project DB settings under `ai_tool_enabled:<id>` — deliberately
the same shape as the plugin system's `plugin_enabled:{id}`, because it is the same idea.

- **Default OFF.** Bundled is not enabled; that is the whole point.
- **Claude is always enabled**, and its checkbox is disabled. It is the fallback transport
  (`transportFor` answers `claude-channel` for anything we do not explicitly drive), so a
  project with nothing enabled must still work. This invariant is what guarantees the
  picker can never end up empty.
- Values are stored as **strings** (the settings table stores strings). `isAiToolEnabled`
  accepts `true` or `'true'` and rejects `'false'` — a plain truthy check would enable a
  tool on the string `'false'`.

## 133.4 The picker

`applyAiToolAvailability` filters the `ai_tool` dropdown to:

1. `auto` — always, since it is a resolution mode, not a tool (docs/132 §132.6)
2. every available **and** enabled tool, suffixed `— beta` / `— unreleased` so maturity is
   visible where the choice is made and not only where it was enabled
3. **the tool the project is already set to** — always, even if neither enabled nor
   shipped

Rule 3 is the HS-9411 exception, and it survived the gate removal because it was never
about gating: hiding the selected value would silently switch a project that works today.

Options that fail the test are set `hidden` **and** `disabled`. A hidden option is still
assignable by value, so a stale saved setting could otherwise re-select a tool the user
can neither see nor turn off.

**Availability is checked independently of enablement.** Otherwise a settings row copied
between projects could resurrect an unreleased tool — a user's own state smuggling in
something never shipped.

## 133.5 Settings → AI tools

Rendered by `client/aiToolsSection.tsx` into `#ai-tools-list`, above the AI-tool picker:
one row per available tool, with a checkbox and a maturity badge (**BETA** /
**UNRELEASED** / **DEFAULT** for Claude). Enabling re-runs the picker filter immediately —
without that, a user ticks the box, finds the dropdown still refusing the tool, and
reasonably concludes the checkbox does nothing.

## 133.6 The one remaining gate

`dev_unreleased_ai_tools` (Settings → Experimental → In Development) reveals the
unreleased integrations so they can be enabled. It replaces the five `dev_tool_*` gates
and is the shape that mechanism is actually for: it gates a **feature** — seeing work we
have not shipped — rather than a tool. Revealed is not enabled; they still have to be
opted into.

## 133.7 Tests

- `aiTools/enablement.test.ts` — maturity declarations (that only Claude and Codex ship),
  availability, enablement defaults, the string-`'false'` case, and the selectable matrix
  including the always-offer-the-current-tool rule and the no-smuggling rule.
- `client/aiToolsSection.test.tsx` — the list (Claude locked on, badges, unreleased hidden
  then revealed), string persistence, and the picker filter including hidden-**and**-
  disabled and label stability across repeated applies.
- `e2e/ai-tool-enablement.spec.ts` — fresh project → Codex listed BETA but off and absent
  from the picker → enable → selectable without reopening Settings → gate reveals the
  unreleased ones.

## 133.8 Cross-references

- [132](132-ai-tool-plugin-interface.md) — the `AiToolPlugin` contract `maturity` is part
  of; §132.11.10 records why the HS-9515 removal was incomplete.
- [124](124-in-development-gates.md) — the In-Development gates, including the one that
  remains for this area.
- [113](113-multi-ai-tool-support.md) — the multi-tool epic and per-tool integrations.
- [18](18-plugins.md) — the bundled-plugin model this mirrors (`plugin_enabled:{id}`).
- [feature-health.md](feature-health.md) — the assessment maturity is meant to track.
