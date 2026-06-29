# 109 — Multi-Client Terminals (Active-Device Model)

> **Status:** Design only (HS-9167). The maintainer selected the **active-device** approach (not size-arbitration). This doc captures the design + a phased build plan; implementation is decomposed into follow-up tickets (see §109.9). Cross-refs: [54-terminal-checkout.md](54-terminal-checkout.md) (checkout/borrow + `slotPlaceholder`), [46-service-client-decoupling.md](46-service-client-decoupling.md) (per-client vs per-project state), [93-websocket-push-sync.md](93-websocket-push-sync.md) (`/ws/sync` event bus), [94-strong-remote-auth.md](94-strong-remote-auth.md) (mTLS per-client identity).

## 109.1 Problem

A terminal PTY is a single process with **one** size (cols × rows). Today every WebSocket client attached to a terminal is an equal subscriber: all receive the PTY output, and **any** of them can drive `resizeTerminal`. With one client that's fine. But once two devices (a laptop and a phone, or two browser tabs on different screens) both render the same terminal live, they fight over the size — each `fit()`s the PTY to its own viewport, so the PTY thrashes between two dimensions (a SIGWINCH storm), corrupting the TUI for both.

This is the multi-client gap from HS-9161. The §54 checkout system already solved the *same-device* version of this (a LIFO stack so only the top consumer renders the live xterm; bumped-down consumers show the "Terminal in use elsewhere" `slotPlaceholder`). HS-9167 extends that principle **across devices**.

## 109.2 Chosen approach — active-device, not size-arbitration

**Only the active device renders terminals live; every other connected device shows the §54 borrowed-terminal placeholder for every terminal.** There is therefore only ever **one live renderer per PTY → one size → no thrash.**

This was chosen over the alternative (let multiple devices render live and *arbitrate* the size — e.g. min-of-all-viewports, or a letterbox/CSS-scale of one canonical size) because:

- It reuses the proven §54 checkout/borrow + `slotPlaceholder` path — a device that isn't active is, conceptually, "borrowed elsewhere."
- One live renderer means the PTY size question never arises — it's the size of whatever device is active.
- The premise is **one device at a time** (you drive from your laptop, glance at your phone). Live *passive* viewing on a second device (laptop-drives + phone-watches-live, via the letterbox/CSS-scale option) is explicitly **out of scope** (§109.8).

A device switch resizes the PTY exactly once (a deliberate handoff), which is acceptable.

## 109.3 Active-device lease (server)

The server tracks a single **active device** per *connection set* and gates terminal behavior on it.

- **Scope decision (CONFIRMED, maintainer 2026-06-29): per-project.** The active device is tracked **per project's connection set** — i.e. per `projectSecret` (the bus key already used by §93). Rationale: terminals are per-project, the `/ws/sync` bus is already keyed by `projectSecret`, and a user can drive project A's terminals on their laptop while another device glances at project B. A single server-global active device was rejected (it couples unrelated projects). This also lines up with the **future multi-server client** direction the maintainer flagged: a single client may end up connected to *several* remote servers at once (each remote project HS-9193 mounts has its own origin + secret), so the natural lease key is the (server, project) pair — which `projectSecret` already is, since each mounted project carries its own secret. Keep the lease keyed by the project's secret, not by anything server-global.
- **Lease, not a flag.** The active claim is a **heartbeat lease** mirroring the §54 checkout lease and the §80 announcer live lease: a TTL (proposed **15 s**, client-renewed every ~5 s). On expiry — the active device slept, lost network, or closed — the slot frees so another device can claim. This avoids a dead device holding the terminals hostage.
- **Last-claim-wins.** A new claim supersedes the current holder immediately (the old active device flips to placeholders on the next lease broadcast). Deliberate handoff, no negotiation.
- **Identity (`deviceId`):**
  - **Tier-1 (exposed / mTLS):** use `peer.clientId` — the stable per-device id already extracted from the client cert (`src/auth/ca.ts::extractClientUri`, tracked on both the terminal and sync sockets via `trackAuthenticatedSocket`). docs/94 §94.5.
  - **Tier-0 (localhost / shared secret):** there is **no** per-client identity today. Mint a **synthetic `deviceId`** — a UUID generated once per browser/Tauri instance and persisted in `localStorage` (survives reload; distinct per device/browser profile). The client sends it on the terminal + sync WS handshakes (query param or header).
- **API surface:** a `POST /api/devices/active` (claim/renew, body `{ deviceId }`, returns the current holder + lease expiry) **or** a `/ws/sync` control frame (`{ type: 'claim-active', deviceId }`). The WS-frame form is preferred (no extra request, rides the existing socket) with the POST as the long-poll-fallback path. A `release` on graceful close frees the lease early.

## 109.4 Output + resize gating (server)

Today (`src/terminals/registry/lifecycle.ts`) every subscriber in `session.subscribers` receives every PTY byte, and any subscriber's resize frame (`src/terminals/websocket.ts` → `resizeTerminal`) hits the PTY. With the active-device model:

- **Non-active devices don't render live terminals at all** — so the simplest, lowest-risk design is: a non-active device **does not open the terminal WS** for any terminal (it shows placeholders), and **only the active device attaches** as a subscriber. Output fanout then needs no change (there's only ever one live subscriber per device-set). When a device becomes active it opens the terminal sockets; when it loses active it closes them and shows placeholders. This reuses the §54 checkout `release()`/placeholder path per terminal.
- **Resize gate (defense in depth):** `resizeTerminal` in `src/terminals/websocket.ts` additionally **ignores resize frames from a socket whose `deviceId` is not the current active holder**. Even if a stale/racing socket sends a resize during a handoff, only the active device can size the PTY. Only the active device's viewport sizes the PTY.

## 109.5 Lease broadcast (server → all clients)

When the active lease is acquired, renewed-after-expiry, or released, the server emits a `/ws/sync` event (new type, e.g. `active-device-changed`, payload `{ deviceId, expiresAt }`) onto the §93 event bus for the project. Every connected client (on every device) receives it (the slot doubles as the `?since` catch-up store), so each device knows whether *it* is active and renders live xterms or placeholders accordingly. A long-poll fallback (`/api/poll` or a dedicated endpoint) covers clients not on WS.

## 109.6 Client behavior

Each device:

1. **Has a stable `deviceId`** (§109.3) — `localStorage` UUID on Tier-0, the mTLS `clientId` on Tier-1.
2. **Claims active on sustained, real interaction** — a keypress or click inside the app, **debounced ~0.5–1 s**, NOT a transient `window.focus` (so merely alt-tabbing past a window doesn't steal control). While the lease is held it renews on a timer.
3. **While active** → renders live xterms exactly as today (checkout into the drawer/dashboard panes).
4. **While non-active** → renders the §54 borrowed-style **placeholder** for every terminal, with a **"View here / take control"** affordance. Clicking it claims active (immediate handoff), flipping this device to live and the previous active device to placeholders on the next broadcast.
5. **Resize** → only the active device drives `handle.resize()` → the WS resize frame (already gated client-side by `isTopOfStack()`; now also gated server-side by the active lease).

## 109.7 Tests

- **Server unit** — the active-device lease state machine: claim, renew, last-claim-wins supersede, expiry frees the slot, release frees early, resize-frame rejected from a non-active `deviceId`. (Pure, clock-injectable, mirroring `coalescingTrigger.test.ts` / the checkout lease tests.)
- **E2E** — two simulated devices (two browser contexts with distinct `deviceId`s) against one server: the non-active context shows placeholders for every terminal; interacting in it (debounced) claims active and flips the contexts (live ↔ placeholder); the previously-active context stops driving resize.

## 109.8 Out of scope (future)

- **Live passive viewing on a second device** (laptop-drives + phone-watches-live) — the letterbox / CSS-scale option from the HS-9161 note. Not needed for the "one device at a time" premise. Would require a canonical PTY size + scaling the non-active render rather than placeholdering it.

## 109.9 Build plan (follow-up tickets)

Decomposed so each phase is independently shippable + testable:

1. **Server active-device lease primitive** — pure lease module (claim/renew/supersede/expiry/release) + the `deviceId` resolution (Tier-1 `clientId` / Tier-0 synthetic) + the claim API (WS frame + POST fallback) + the `active-device-changed` `/ws/sync` event. Unit tests for the state machine. *(Foundation — everything else depends on it.)*
2. **Server output/resize gating** — only the active device attaches/subscribes; `resizeTerminal` rejects non-active `deviceId`s. Tests that a non-active socket can't size the PTY.
3. **Client device identity + active claim** — `localStorage` `deviceId`, sustained-interaction debounced claim + lease renewal, and the active/non-active state driving live-vs-placeholder per terminal (reusing the §54 checkout placeholder). 
4. **Client placeholder + "take control" affordance** — the non-active placeholder variant with the claim button; wire the `active-device-changed` event to flip rendering.
5. **E2E two-device flow** — the §109.7 e2e.

(Phases 3–4 may merge in practice; keep 1–2 separate so the server foundation lands + is tested before the client work.)
