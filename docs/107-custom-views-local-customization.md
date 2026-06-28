# 107. Local Customization for Custom Views

**Status: SHIPPED** (HS-9017 design; HS-9092 sidebar + HS-9093 Settings "Views"
tab, 2026-06-26). Custom views were **shared-only**: they defaulted to the shared
layer and are managed from the **sidebar** (not the Settings dialog), so the
dialog-wide Shared|Local|Resolved scope control (§95) doesn't reach them. This
added per-machine local customization. The delta infra was already in place
([95-settings-sharing-classification.md](95-settings-sharing-classification.md)
§95.3: `src/settingsDelta.ts` `resolveDeltaArray` for `custom_views`, `idOf=id`;
`readFileSettings` is delta-aware) — these tickets are the **UI + delta writes**.

**Implementation:** the pure layer logic lives in `src/client/customViewsLayers.ts`
(`addLocalView`/`addSharedView`/`editView` [layer-routed]/`hideSharedView`/
`unhideSharedView`/`deleteLocalView`/`reorderViews` [per-layer]/`moveViewToLocal`/
`moveViewToShared`), unit-tested in `customViewsLayers.test.ts`. `customViews.tsx`
loads the shared array + local delta via `getLayeredFileSettings` and routes each
action through `persistViews` (writes only the changed layer; clears the local key
when the delta empties). The sidebar offers hide-on-this-machine + Undo (HS-9092);
the shared/local origin badges that used to sit on each sidebar row were **removed
in HS-9122** (noise — the distinction lives on the Views settings tab). The
Settings → **Views** tab (HS-9093) is the power
surface (add Local|Shared, Edit, Hide/Unhide, Move between layers, Delete). e2e in
`e2e/custom-views-local.spec.ts`. The Views tab manages layers per-row, so it's
intentionally not driven by the §95 scope control.

## 107.0 Maintainer-specified behavior (HS-9017 note)

Two surfaces, with explicit rules:

### Sidebar (inline, the common path)
- **Add a custom view → adds LOCALLY by default** (writes the local `custom_views`
  `added` delta). The everyday "I want a view on this machine" case stays
  one-click and never touches the shared/committed layer.
- **Edits indicate which layer they happen at, but the layer is NOT selectable**
  inline — editing follows where the view lives:
  - A view that lives at the **shared** layer **indicates "shared"**, and editing
    it changes the **shared** layer.
  - A view that lives **locally indicates "local"**, and editing it changes the
    **local** layer.
- (Implied) a **"hide on this machine"** affordance for a shared view (writes the
  local `hidden` delta) with a muted hidden-locally state + undo — from the
  original approach (A).

### Settings → new "Views" tab (powerful management)
- Lists the **same views** as the sidebar, with richer management.
- **Hide** shared custom views (per-machine).
- **Add** new **shared OR local** views (here the layer **is** selectable, unlike
  the sidebar).
- **Move a custom view between local and shared** (both directions).

## 107.1 Why a Views tab (not just the sidebar)

The sidebar keeps the fast, low-friction path (local-by-default add, layer-implied
edit). The Settings "Views" tab is where the maintainer does the deliberate,
layer-aware work — choosing a layer on add, hiding shared views, and promoting/
demoting between layers — mirroring how the other complex editors live in the
Settings dialog with the scope control, except views also keep their sidebar home.

This resolves the original §95.3 tension (views are sidebar-managed so the
dialog scope control doesn't reach them): instead of forcing views into the
generic scope control, give them a **dedicated tab** with view-appropriate
affordances + keep the inline sidebar affordances for the common case.

## 107.2 Mechanics (reuse the delta infra)

The local layer for `custom_views` is the standard `ArrayDelta` object
`{ hidden: [id…], added: [item…], overrides: { id: partial } }`, resolved by
`resolveDeltaArray(shared, local, idOf=id)` — **already wired**. So every UI
action is a delta write via `updateFileSettingsLayer('local'|'shared', …)`:

| Action | Layer write |
|---|---|
| Sidebar add (default) | local `added += view` |
| Sidebar edit a local view | local `added[i]` (or `overrides`) update |
| Sidebar edit a shared view | shared array update |
| Sidebar "hide on this machine" (shared view) | local `hidden += id` |
| Settings add → Local | local `added += view` |
| Settings add → Shared | shared array `+= view` |
| Settings hide shared view | local `hidden += id` |
| **Move shared → local** | remove from shared array **and** add to local `added` (net resolved list unchanged; view now lives in the local layer, so it's not committed) |
| **Move local → shared** | move the local `added` item into the shared array, drop it from the local delta |

The **move** ops are the higher-level two-layer primitive (edit both layers in one
action), identical in spirit to the custom_commands shared↔local move
([95-settings-sharing-classification.md](95-settings-sharing-classification.md)
§95.3 / HS-9014). Views are **flat** (no group tree), so the flat `resolveDeltaArray`
suffices — no tree-aware resolver needed (that's the custom_commands superset).

## 107.3 UI details

- **Layer indicator** — each view (sidebar + tab) shows a small **Shared** /
  **Local** badge so the maintainer always knows where an edit lands (the note's
  "edits indicate which level" requirement). Muted **hidden-locally** state for a
  shared view hidden on this machine, with **undo**.
- **Sidebar add** — default Local, no layer picker (keep it one-click). The
  layer choice lives in the Views tab.
- **Views tab** — a list mirroring the sidebar order, with: add (Local|Shared
  picker), hide (shared rows), a per-row **"Move to Local / Move to Shared"**
  action, and edit (routing to the right layer). Reuse the §95 layer-aware editing
  affordances where they fit.

## 107.4 Open questions

- **Order across layers** — `resolveDeltaArray` appends `added` after the kept
  shared list; §95.3 has **no order override** for the delta keys. Confirm views
  are fine with "shared first, then local-added" ordering (likely yes; the sidebar
  has its own ordering today — verify it composes).
- **Edit of a shared view from a follower machine** — editing a shared view writes
  the **shared** layer (committed). Confirm that's intended from the sidebar (the
  note says shared-view edits are shared) vs. only allowing shared edits from the
  Views tab. Lean: allow from both, badge makes it clear.
- **Move semantics on conflict** — moving shared→local then editing shouldn't
  resurrect the shared copy; ensure the move removes the shared entry atomically
  (mirror the HS-9014 two-layer-move tests).
- Whether the Views tab subsumes or coexists with the existing sidebar
  view-management menu (lean coexist — tab is the power surface, sidebar the quick
  one).

## 107.5 Tests

- Unit (delta writes): each row in the §107.2 table produces the expected
  local/shared layer state; the two-layer **move** (shared item removed from
  shared + present in local, and the reverse) leaves the resolved list unchanged.
- Unit: hide a shared view (local `hidden`) → resolved list omits it; undo
  restores.
- e2e (sidebar): add a view → it's local (shared `settings.json` unchanged,
  `settings.local.json` holds the `added` delta); editing a shared view writes
  shared; "hide on this machine" mutes + persists locally.
- e2e (Views tab): add Local vs Shared lands in the right file; Move to Shared /
  Move to Local round-trips.

## 107.6 Follow-up tickets

- *(SHIPPED — HS-9092)* Sidebar inline affordances — local-by-default add,
  layer-implied edit + badge, "hide on this machine" + undo (§107.0 sidebar, §107.3).
- *(SHIPPED — HS-9093)* Settings "Views" tab — list + add(Local|Shared) + hide +
  edit + the shared↔local **move** action (§107.0 settings, §107.2 move).
- Relates: HS-9013 (parent, deferred here), HS-9012 (delta infra), HS-9014
  (custom_commands shared↔local move — the analogous two-layer op), §95 §95.3.

### Resolved open questions (§107.4)
- **Order across layers** — confirmed: resolved order is shared-first then
  local-added (`reorderViews` reorders within a layer only; no cross-layer drag).
- **Edit a shared view from the sidebar** — allowed from both the sidebar + Views
  tab; the origin badge makes the target layer clear.
- **Views tab vs sidebar menu** — they coexist (tab = power surface, sidebar =
  quick). The Views tab is **not** wired to the §95 scope control (it manages
  layers per-row); **HS-9096 (SHIPPED)** disables the dialog-wide scope bar on the
  Views tab (a `PER_ROW_LAYER_TABS` set in `settingsScope.tsx`, mirroring the
  global-only-tab handling but with a "layers are managed per-view" note — Views
  is NOT machine-global).
