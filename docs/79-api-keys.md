# 79. Global API-Key Registry

**Status: Shipped (HS-8751, 2026-06-05).** A single, machine-global list of
named API keys (Anthropic) that every project selects from, instead of
re-entering a secret per project. Replaces the announcer's former per-project
key field (§78.12). From HS-8751. **UI revised by HS-8759/8760/8761/8763
(2026-06-05)** — see §79.5.

## 79.1 Motivation

Before this, the only AI secret in the app was the announcer's Anthropic key,
entered per project and stored in the keychain under a single fixed account
(`announcer/anthropic_api_key`). That doesn't scale: a user with several
projects re-enters the same key everywhere, and there's no place for additional
secret *types* (e.g. a Google Cloud TTS key for §78.6 Phase 3). HS-8751
introduces a global registry the projects choose from by name.

## 79.2 Model

A **key** has these fields:

- **type** — a fixed enum. **Only `anthropic_api_key` today** — Google Cloud TTS
  (`google_tts_key`) was registerable but had no consumer, so HS-8763 dropped it
  "for now". Re-adding a type is a one-line change to `KeyTypeSchema`
  (`src/routes/validation.ts`) + the client label map (`keysSettings.tsx`). A
  key's type is **fixed at creation** — the UI never lets you change it after the
  fact (HS-8759); with a single type it renders as a static label, not a select.
- **name** — free-text label the user types (e.g. "Personal", "Work").
- **value** — the secret itself, **write-only**: sent on create/update, never
  returned over the wire or shown in the UI.
- **created_at / updated_at** — ISO timestamps (HS-8760), stamped on create and
  bumped on every edit; surfaced as a "Created …/Updated …" label in the row.
  Optional in the schema for back-compat with keys created before HS-8760.

**Per-project selection.** A project picks a key *by id* (the UI shows it by
name). With no selection, it **defaults to the first key of the matching type**.
The announcer stores its choice in the per-project `announcer_ai_key_id`
setting; future consumers (Google TTS) add their own per-project selection
setting.

## 79.3 Storage (split, so secrets never hit config/git)

- **Metadata** `{ id, type, name, created_at, updated_at }` → `~/.hotsheet/config.json` under `keys`
  (the global config, `src/global-config.ts`; schema `SecretKeyMetaSchema` in
  `src/routes/validation.ts`). Machine-global, shared across every project.
- **Value** → the OS keychain (`src/keychain.ts`), plugin id `keys`, account =
  the key's generated `id` (`com.hotsheet.plugin.keys` service). Same keychain
  the rest of the app uses (§20); on platforms without a keychain it degrades to
  the keychain module's file fallback.

`src/secret-keys.ts` is the one module that joins the two halves:
`listKeyMetas`, `createKey`, `updateKey`, `deleteKey`, `getKeyValue`, and
`resolveKeyValueByType(type, selectedId?)` (the "selected, else first of type,
else null" resolver).

## 79.4 API

`src/routes/keys.ts`, mounted at `/api`; typed wire schemas + callers in
`src/api/keys.ts` (the SSOT, `git`-style typed layer §9):

- `GET  /api/keys` → `{ keys: SecretKeyMeta[] }` (metadata only).
- `POST /api/keys` `{ type, name, value }` → `{ key }`.
- `PUT  /api/keys/:id` `{ type?, name?, value? }` → `{ key }` (404 if unknown;
  a blank/omitted `value` keeps the stored secret).
- `DELETE /api/keys/:id` → `{ ok: true }` (404 if unknown).

The announcer's key endpoint changed accordingly (§78.12): the old
`PUT /api/announcer/key` (which stored a raw key) is gone; in its place
`POST /api/announcer/key-selection` `{ keyId: string | null }` records the
project's choice, and `GET /api/announcer/status` now also returns
`selectedKeyId`.

## 79.5 UI

A new **Settings → "API Keys"** tab (a global-setting section, `keysSettings.tsx`):

- A list of editable rows — name (debounced rename), a **static type label**
  (HS-8759; never a select, since type is immutable and single-valued), an
  **edit** button (pencil icon) that opens a value dialog, and a lucide **trash**
  delete button (Tauri-safe `confirmDialog`, never `window.confirm`). A
  "Created …/Updated …" provenance label sits where the old inline "Replace
  value…" field used to be (HS-8760).
- An **"Add a key…" button** that opens a dialog with full-width **Name** and
  **Value** fields (HS-8761). With a single type there's no type picker; new keys
  are `anthropic_api_key`. Both the add and the edit-value dialogs are in-app
  overlays built on the `confirm.tsx` shell (`openKeyFormDialog`), never
  `window.prompt`.
- Mutations broadcast `hotsheet:keys-changed` so dependent selectors refresh
  live — notably the announcer's selector in the same dialog.

The **announcer settings** (Settings → Experimental, §78.12) replaces its former
key input with a dropdown of Anthropic keys by name + a "Default — first
Anthropic key" option.

## 79.6 Tests

- `src/secret-keys.test.ts` — CRUD + `resolveKeyValueByType` (default-to-first,
  honor-selection, fall back on unknown/wrong-typed id, null when none) against a
  temp global config + an in-memory keychain stub.
- `src/api/keys.test.ts` — typed caller paths/bodies + request-schema validation.
- `src/routes/keys.test.ts` — route CRUD, validation 400s, 404s (registry mocked).
- `src/announcer/key.test.ts` — env override, selection pass-through, default,
  and the get/set selection round-trip.
- `e2e/keys.spec.ts` — real client: add a key in the API Keys tab → it lists →
  the announcer selector picks it up via `hotsheet:keys-changed` and posts the
  selection by id. Routes intercepted (no real keychain/config).

Real-keychain persistence + cross-restart survival of the value is a manual item
(see `docs/manual-test-plan.md`), since automation stubs the keychain.

## 79.7 Scope / follow-ups

This round covers **Anthropic AI keys only**. Google Cloud TTS keys
(`google_tts_key`) were registerable in the first cut but had no consumer; HS-8763
dropped the type until Google Cloud TTS actually ships (§78.6 Phase 3), at which
point re-adding it is a one-line enum + label-map change. Folding existing
**plugin secrets** (§20, e.g. the GitHub plugin token) into the same registry is
deliberately out of scope — they have a different per-plugin shape — and is left
as a possible later unification.
