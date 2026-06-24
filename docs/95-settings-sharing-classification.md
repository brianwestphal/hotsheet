# 95. Settings Sharing Classification & Per-Layer Editing (HS-9005)

Follow-up to HS-9004 (the dialog-wide **Shared | Local overrides | Resolved** scope control, docs/2 §2.3.1). HS-9004 made the *scalar* file-settings fields per-layer aware and locked the complex list/tree editors read-only outside Resolved. This doc defines:

1. **How every setting is classified** — personal (local) vs team (shared) vs machine-identity (global) vs hard rule — so the scope control surfaces each correctly.
2. **Per-layer editing semantics for the complex editors** — which is *element-level* (hide / add-local / override individual), not the whole-key replacement the file layers do natively.
3. **The standing rule**: complex editors are case-by-case. When adding a new complex setting (or when an existing classification is unclear), **ask the maintainer** what the sharing behavior should be — encoded in both code (a comment at the registry) and here.

> **Status: Classification DECIDED (§95.4, maintainer 2026-06-24). Phase 1 shipped — `defaultScope` reclassification (the personal/machine keys now default to the `local` layer). Phase 2+ (scope-control affordances + element-level editors) are decomposed into follow-up tickets.**

## 95.1 Storage buckets (recap)

| Bucket | File | Committed? | Meaning |
|---|---|---|---|
| **Shared** | `.hotsheet/settings.json` | yes (git) | team / project policy — everyone on the repo gets it |
| **Local** | `.hotsheet/settings.local.json` | no (gitignored) | this checkout / this person's preference |
| **Global** | `~/.hotsheet/config.json` | no (machine) | machine-wide identity/preference, spans every project |

The scope control (`settingsScope.tsx`) operates on Shared vs Local. Global settings keep their "Global Setting" badge and are layer-agnostic (editable in any mode). The resolved view the app runs on is `{...shared, ...local}` for file keys.

## 95.2 Classification principle

Ask, per setting: **whose decision is it?**
- **A team/project decision** that should travel with the repo → **Shared** (categories, ticket prefix, worklist preamble, AI/auto-context).
- **A personal preference** that shouldn't be imposed on teammates → **Local** (view layout, sort, notifications, which terminals *I* run).
- **Machine-specific** (paths, ports, device grants, device perf) → **Local**.
- **Identity / machine-wide** (API keys, billing model, on-device model choice) → **Global**.
- **A hard rule** (must be uniform) → Shared with no local override.

## 95.3 Complex-editor semantics (maintainer-specified, HS-9005)

These editors are **element-level**, not whole-array. The local layer stores a *delta*, not a replacement. **Reordering works within each layer independently — the local layer cannot reorder *shared* items**; resolved order = shared items in shared order (minus hidden, each with its override) followed by local-only items in local order:

- **categories** — **Shared only.** No local overrides.
- **custom_views** — Local may **hide individual shared views** + **add local-only views**. No order override.
- **custom_commands** — Local may **hide individual shared commands** + **add local-only commands**, including **adding into a shared-defined group**. If a parent group later disappears from shared, a local child still survives (in its own local group). No order override.
- **terminals** — Local may **hide individual shared terminals** + **add local-only terminals**. No order override.
- **auto_context** — Local may **disable individual rules**, **override individual rules**, and **add local-only rules**. No order override.
- **permission_allow_rules** + **terminal_prompt_allow_rules** — **Local only, never shared.**
- **Announcer** — **Local only, never shared**, including `announcer_enabled` and the speak-permissions flag. (Note: this reverses HS-9006, which shipped `announcer_enabled` as a shared-default scoped field — see §95.5.)

### Delta model (shipped — HS-9012)
For the element-level keys, the local layer holds an object `{ hidden: [id…], added: [item…], overrides: { id: partial } }`. Resolved = shared list minus `hidden`, each surviving item shallow-merged with its `overrides`, then `added` appended. The pure resolver lives in **`src/settingsDelta.ts`** (`resolveDeltaArray` / `isArrayDelta` / `ArrayDelta<T>`), wired into `readFileSettings` (`src/file-settings.ts`) for `custom_views` (idOf = `id`), `terminals` (idOf = `id`), and `auto_context` (idOf = `type:key`). It's gated strictly on the local value being a delta OBJECT — a plain-array / absent local is left untouched (legacy whole-replacement + legacy stringified arrays preserved), so it's a **true no-op until an editor writes a delta**. `custom_commands` is a nested group tree and gets its own tree-aware resolver in HS-9010c.

## 95.4 Classification (DECIDED 2026-06-24)

**Local (personal / machine — never committed):** `hide_verified_column`, `sort_by`, `sort_dir`, `layout`, `notify_completed` (and `notify_permission`), `auto_order`, `shell_integration_ui`, `shell_streaming_enabled`, `terminal_scrollback_bytes`, `terminal_default`, `confirm_quit_with_running_terminals` + `quit_confirm_exempt_processes`, `db_snapshot_protection`, `telemetry_enabled` + sub-toggles + `telemetry_retention_days`, plus the existing locals (`backupDir`, `port`, allow-rules, `announcer_ai_key_id`/`announcer_last_listened_at`, `detail_*`/`drawer_*`, `*_nudge_dismissed`). **Phase 1 made these default to the `local` layer** (`LOCAL_SCOPE_KEYS` in `src/file-settings.ts`). On next startup `migrateLocalScopedKeys` relocates any committed values into `settings.local.json`.

**Shared, with local override allowed (team policy, personal exception possible):** `worklist_preamble`, `trash_cleanup_days`, `completed_cleanup_days`, `verified_cleanup_days`.

**Shared ONLY (no local override — hard team value):** `appName`, `ticketPrefix`, `categories`. The scope control must NOT offer "+ Override" for these (Phase 2).

**Local ONLY (never shared):** `permission_allow_rules`, `terminal_prompt_allow_rules`, and the **Announcer** (`announcer_enabled` + `announcer_dismissed_topics` + the per-project key selector). The scope control must hide/lock these in the **Shared** view (Phase 2).

**Global (machine-wide, `~/.hotsheet/config.json` — already never committed):** the Announcer model / rate / fallback / local-endpoint / **speak-permissions**; telemetry billing mode; diagnostics; terminal renderer opt-out; API keys. Left as-is — "Global Setting" badge, layer-agnostic.

**Dropped (HS-9011):** `appIcon` — the dynamic app-icon feature was removed end-to-end (it had been dormant: picker hidden + startup-apply flagged off). See the §13 tombstone.

### Reorder rule (Q3 refinement)
Reordering works within each layer independently; the local layer **cannot** reorder shared items. Resolved = shared order (minus hidden, with overrides) then local-added items in their local order.

## 95.5 Corrections to prior tickets
- **HS-9006** shipped `announcer_enabled` as a Shared-default scoped field. Phase 1 reclassified it to the **local** layer (`defaultScope` now returns `local`), so new edits + the migration route it to `settings.local.json`. The remaining "local-only — hide in the Shared view" UI lock is Phase 2 (the scope-control affordances follow-up).

## 95.7 Phasing
- **Phase 1 (shipped, HS-9005):** `defaultScope` reclassification per §95.4 + tests + this doc. Personal/machine settings now default-route to `local`.
- **Phase 2 (shipped, HS-9009):** scope-control affordances — a `share` classification on the scalar fields (`shared-only`: appName, ticketPrefix — editable in Shared, read-only "shared only" in Local, no "+ Override"; `local-only`: announcer_enabled — editable in Local, read-only "local only" in Shared) + `data-scope-complex="shared-only"` (categories — locks in Local only) / `data-scope-complex="local-only"` (permissions/allow-rules, Announcer key+topics — lock in Shared only) panel variants, with matching lock-chip text.
- **Phase 3 (decomposed, HS-9010):** element-level per-layer editing for `custom_views`, `custom_commands` (group-aware), `terminals`, `auto_context` — the delta model in §95.3 + the reorder rule. Split into sub-tickets: **HS-9010a / HS-9012 — SHIPPED** (the delta-merge infrastructure: `src/settingsDelta.ts` + `readFileSettings` wiring for the 3 flat keys, gated as a true no-op until writers exist) → **HS-9010b / HS-9013** (custom_views) / **HS-9010c / HS-9014** (custom_commands, group-aware — adds its own tree resolver) / **HS-9010d / HS-9015** (terminals) / **HS-9010e / HS-9016** (auto_context). Each per-editor ticket unlocks its `data-scope-complex` marker once editable.
- **Done (HS-9011):** `appIcon` evaluated + dropped end-to-end (the feature was dormant).

## 95.6 Standing rule
When a **new complex/list setting** is added, or an existing classification is ambiguous, **do not guess** — ask the maintainer how it should be shared (team / personal / machine / hard rule). This rule is mirrored as a comment on `SCOPED_FIELDS` / the `data-scope-complex` markers in code.
