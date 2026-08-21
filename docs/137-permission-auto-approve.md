# 137. Auto-Approve Permission Requests After a Timeout

HS-9702. A per-project **opt-in** setting that automatically **approves** a pending
permission request if the user doesn't make a decision within a chosen window
(15 seconds, or 1 / 2 / 5 / 15 / 60 minutes). The permission popup shows a live countdown with a
**Cancel** button so the user can see the auto-approval coming and stop it.

> **Status:** Shipped (HS-9702). Off by default; local-only (per-machine, never
> committed); audit-logged. Client-driven countdown + fire, with a channel-side
> lifetime extension so long windows aren't abandoned mid-countdown.

Complements §47 (the richer permission overlay + per-project auto-**allow rules**).
Where §47 auto-allows requests matching a `{tool, pattern}` rule *immediately*
(before the popup renders), §137 auto-approves *any* surfaced request the user
leaves unanswered — a time-based safety valve for "I stepped away, keep working."

## 137.1 Problem statement

The permission overlay (§47, §12.10) blocks the driven agent until the user clicks
Allow / Deny. When the user is away from the keyboard the agent stalls indefinitely
(bounded only by the channel's §HS-9299 15-minute abandon backstop, which *drops*
the popup without deciding — the agent stays blocked). For unattended or
low-risk workflows the user wants "if I don't answer within N minutes, just approve
it and let the agent continue" — without wholesale-disabling permissions (which
loses the prompt for the requests that matter).

## 137.2 Scope

**In scope.**
- A per-project **Settings → Permissions** dropdown: `Off` (default) / 15 seconds /
  1 / 2 / 5 / 15 / 60 minutes.
- A live **countdown** in the permission popup (`Auto-approving in M:SS`) with a
  **Cancel** button that stops the auto-approval and keeps the popup open for a
  manual decision.
- Applies to **every** surfaced permission request for the project (all tools). The
  §47 auto-allow rules still take precedence (a rule-matched request never surfaces
  a popup, so it never reaches the countdown).
- An audit entry in the Commands Log distinct from a manual allow
  (`Permission: <tool> — Auto-approved (timeout)`).

**Out of scope.**
- Auto-**deny** after a timeout (the §47 rationale applies: a user who wants to block
  a tool configures that in the agent).
- Per-tool windows / per-rule overrides (one project-level window; revisit if needed).
- Auto-approving when **no client is present** (see §137.4 — the countdown is
  client-driven, so a running app/overlay is required; the visible-countdown UX the
  maintainer chose inherently assumes one).

## 137.3 Setting

`permission_auto_approve_ms` — a scalar in `<dataDir>/settings.local.json`:
- `0` / absent = **Off** (the default).
- One of `15000` / `60000` / `120000` / `300000` / `900000` / `3600000` (15s + 1/2/5/15/60 min).

Declared in `src/file-settings.ts` (`FileSettingsSchema` + the `FileSettings`
interface) and listed in **`LOCAL_SCOPE_KEYS`**, so §95 routes it to the local layer
alongside `permission_allow_rules` — it's a per-machine safety/convenience
preference, never shared with the team. The **Permissions** tab is already
scope-bar-hidden / machine-local (§95.1, HS-9157), so the dropdown drops in without
scope-control work.

The allowed values, validation, and formatting live in one DOM-free, dependency-free
module **`src/permissionAutoApprove.ts`** (shared by the settings UI, the overlay,
the main-server poll, and the channel server):
- `AUTO_APPROVE_OPTIONS` — the ordered dropdown choices (`{ms, label}`; `ms:0` = Off).
- `parseAutoApproveMs(raw)` — **fail-closed** coercion: anything that isn't exactly
  one of the offered enabled windows (a string, a legacy/garbage value, a negative,
  `NaN`) collapses to `0` (Off), so a bad setting can never auto-approve on an
  unexpected schedule.
- `formatCountdown(ms)` — `M:SS`, rounding **up** to whole seconds (the last tick
  shows `0:01`, not a premature `0:00`).
- `isEnabledAutoApproveMs` / `isAutoApproveEnabled` / `autoApproveRemainingMs` /
  `autoApproveLabel` — supporting predicates + helpers.

## 137.4 Architecture — where the timer lives

Enforcement is **client-driven**: the permission overlay renders the countdown and,
on reaching the deadline, fires the normal allow path. This is the natural fit for
the chosen **visible countdown** UX (a countdown *requires* a client to display it),
and it keeps the decision on the same code path as a manual click. Three server-side
pieces support it:

1. **Deadline computation (main server, `src/routes/projects.ts`).** The
   `GET /api/projects/permissions` poll attaches an `auto_approve_at` (epoch-ms
   deadline) to each pending entry, computed from the **owning** project's
   `permission_auto_approve_ms` window plus the request's channel-side enqueue
   `timestamp`. Computing it server-side (rather than reading `state.settings`
   client-side) means the deadline reflects the *owning* project's setting, not the
   active tab's — a background-project popup counts down correctly. The per-request
   deadline is cached (`computeAutoApproveAt`, capped) so the settings file isn't
   re-read on every ~100 ms poll (`dataDir` may be a slow cloud path — docs/128).
   `auto_approve_at` is absent when auto-approve is off for that project.

2. **Wire plumbing.** `timestamp` and `auto_approve_at` are added to
   `PendingPermissionEntrySchema` (`src/schemas.ts`), and `auto_approve_at` to the
   client's `PermissionEntrySchema` (`src/api/projects.ts`) — the latter is **not**
   `.loose()`, so the field MUST be named there or zod strips it (the HS-9586
   lesson). `PermissionData` (`permissionOverlayHelpers.ts`) carries `auto_approve_at`.

3. **Channel-side lifetime extension (`src/channel.ts` + `src/channelPermissions.ts`).**
   `peekPending(now, loneTtlMs?)` takes an optional lone-request backstop override.
   The channel's `GET /permission` reads its own project's window (cached) and passes
   `max(PERMISSION_LONE_TTL_MS, window + grace)`, so a lone request the overlay is
   counting down on isn't abandoned by the 15-minute §HS-9299 default before the
   window elapses (critical for the 15- and 60-minute options). Only the **lone**
   backstop is extended — a head *blocking* a newer request still expires at the
   short `PERMISSION_TTL_MS` so the queue can advance. **No channel-protocol change**
   (the `/permission` wire shape is unchanged; `timestamp` was already emitted), so
   `CHANNEL_VERSION` is **not** bumped.

### 137.4.1 Overlay behavior (`src/client/permissionOverlay.tsx`)

When `perm.auto_approve_at` is set (and the request hasn't been cancelled), the popup
inserts a `.permission-auto-approve` row above the footer links with a live
`Auto-approving in M:SS` label + a **Cancel** button, and starts a 1 s interval:
- Each tick recomputes the remaining time against `Date.now()`; at ≤ 0 it calls
  `respondToPermission('allow', undefined, { auto: true })`.
- The interval **self-heals**: if the popup DOM was removed by a path that didn't
  clear the timer (e.g. the poll-driven auto-dismiss), the next tick sees
  `!overlay.isConnected` and stops rather than approving a vanished request.
- **Cancel** clears the interval, records the `request_id` in the module-level
  `autoApproveCancelledRequestIds` set (so a minimize→reopen or a re-poll doesn't
  restart the countdown), and removes the row while leaving the popup open.
- Every teardown path (`respondToPermission`, `cleanupAndDismiss`,
  `cleanupAndMinimize`) stops the timer.

### 137.4.2 Audit

`respondToPermission('allow', …, { auto: true })` sends `auto_approved: true` on the
respond body (`PermissionRespondSchema`). The main server's
`POST /channel/permission/respond` logs the decision as
`Permission: <tool> — Auto-approved (timeout)` (vs `Allowed` for a click), mirroring
§47's `Auto-allowed (rule …)` wording. The channel server strips the extra field
(default `z.object`), so no channel change is needed.

## 137.5 Multi-client + edge cases

- **Multiple clients / devices.** Each running overlay counts down independently; the
  first to fire wins. A second allow for an already-completed request is a no-op
  (client `respondedRequestIds` dedup + the channel's `completePermission`).
- **App closed / no overlay.** Nothing auto-approves; the request waits (and is
  eventually abandoned by the channel backstop, as today). The feature is a
  UI-assisted convenience, consistent with the visible-countdown choice.
- **`tauri:dev` vs packaged.** Purely client + main-server + channel-server code;
  identical in browser and Tauri.
- **ACP permissions.** The ACP bridge path (`pendingAcpPermissionForSecret`) also
  carries a `timestamp`, so ACP requests get an `auto_approve_at` too.

## 137.6 Tests

- `src/permissionAutoApprove.test.ts` — the pure helpers (options, fail-closed
  `parseAutoApproveMs`, `formatCountdown` rounding, remaining-ms clamp, labels).
- `src/channelPermissions.test.ts` — `peekPending` honoring an extended `loneTtlMs`
  (lone request survives past the 15-min default; a blocking head still expires at
  the short TTL; omitting the param preserves the pre-feature default).
- `src/file-settings.test.ts` — `permission_auto_approve_ms` classified `local`.
- `src/client/permissionOverlay.test.ts` — the countdown renders/ticks, auto-approves
  (allow) at zero and tears the popup down, Cancel stops it + keeps the popup open +
  never fires, and a previously-cancelled request doesn't restart its countdown.
- `src/client/permissionAllowListUI.test.tsx` — the dropdown reflects the persisted
  window, defaults to Off, persists a change (local-only), and fails closed on an
  out-of-range value.
- E2E (`e2e/permission-auto-approve.spec.ts`) — the Settings → Permissions dropdown
  round-trips through `settings.local.json`.
