# 46. Service / Client Decoupling (Design Spike)

HS-7938. Detach the Hot Sheet **service** (HTTP server + dataDir + plugins + backups + channel sidecar) from the Tauri desktop **client** so multiple clients of varying form factors (desktop browser, Tauri shell, mobile browser, future iOS app) can connect simultaneously to a single service instance over WebSocket for near-real-time synchronisation. The original ticket scope ("iPhone remote access") becomes one form factor of a broader architecture.

> **Status:** Design only. Implementation phased into HS-7940 (server-side `--bind` opt-in + auth), HS-7944 (service-only mode + Tauri shell with `--service-url`), HS-7945 (WebSocket push replacing `/api/poll`), HS-7946 (multi-client conflict UX), HS-7941 (mobile client / PWA), HS-7942 (Tailscale UX sugar).

## 46.1 Problem statement

Today's architecture is single-process: the Tauri desktop window owns the Hono server, the PGLite dataDir, and the only client UI all in one process. Implications:

- The **client** can only run on the same machine as the dataDir
- Mobile / iPhone access requires either replicating the dataDir (sync hell) or routing localhost through Tailscale (the original §46 v1 framing — useful, but tactical)
- A user with multiple machines (laptop + desktop) effectively has multiple Hot Sheet installations to keep manually in sync
- Multiple users / collaborators can't share a Hot Sheet workspace
- The "view-only auxiliary screen" pattern (e.g. a dashboard on a side monitor) requires running a second full instance

The user's revised goal: **the Hot Sheet service is detachable from the client.** One service, many clients, WebSocket push for synchronisation. The desktop client stays the primary form factor; the mobile client is a first-class secondary; multiple simultaneous clients of either type are allowed.

## 46.2 Architectural shift

**Service** — the long-running process. Owns:
- The PGLite dataDir + write authority
- The Hono HTTP API + WebSocket sync channel
- Plugins (sync engine, GitHub backend, etc.)
- Backups, channel sidecar, terminal PTYs, command log
- Markdown export (`.hotsheet/worklist.md`, `.hotsheet/open-tickets.md`)

**Client** — pure UI. Owns:
- Per-client state (selection, search query, active project, drawer state, layout mode)
- Connection to a service URL
- A WebSocket subscription that receives state updates and merges them in
- An HTTP request path for mutations (POST/PATCH/PUT/DELETE)

The Tauri desktop app becomes either:

- **Co-located mode** (today's behaviour, mostly preserved) — the Tauri process spawns the service as a sidecar; the webview connects to `localhost:<port>`. Single-machine users get one-click launch with no setup.
- **Remote mode** (new) — the Tauri shell is started with `--service-url <url>` (or via an in-app setting). It does NOT spawn a sidecar; instead the webview points at the remote service. Useful for "I keep my workspace on the home server but I'm on my laptop today" workflows.

A pure web client (Mobile Safari, Chrome on a guest machine) is just the same JS bundle served by the service over HTTP — no Tauri shell needed.

## 46.3 Synchronisation model

**Today's polling.** Clients hit `GET /api/poll?version=<N>` (long-poll, 30s timeout, returns when `version > N` or on timeout). Mutations bump a process-local version counter via `bumpChangeVersion()`. The polling client refetches the relevant lists. Every client roundtrips a full ticket list on every mutation — wasteful at one client, untenable at many.

**Push-based replacement (HS-7945).** Each client opens a WebSocket to `/ws/sync?project=<secret>` and subscribes to typed events:

```
{ type: 'ticket-created', ticket: {...} }
{ type: 'ticket-updated', id, changes: {...} }
{ type: 'ticket-deleted', id }
{ type: 'note-added', ticketId, note: {...} }
{ type: 'note-deleted', ticketId, noteId }
{ type: 'category-changed', from, to, ticketIds: [...] }
{ type: 'priority-changed', ... }
{ type: 'attachment-added', ticketId, attachment: {...} }
{ type: 'settings-changed', key, value }
```

The service emits the relevant event on every mutation (synchronously enqueued during the API handler, dispatched after the response is sent so the originating client also receives confirmation). Clients merge into local state without a refetch.

**Backwards-compat fallback.** Polling remains available for clients that can't sustain a WebSocket (corporate proxies, legacy plugins). The fallback is automatic — if the WebSocket connect fails or drops twice in 30s, switch to `/api/poll` and surface a "live updates unavailable" hint in the UI.

**Heartbeat + reconnect.** Service sends a `{type: 'ping'}` every 20s; client replies `{type: 'pong'}`. Either side closes the connection if 2 consecutive heartbeats are missed. Client reconnects with exponential backoff (1s, 2s, 4s, ..., capped at 30s). On reconnect, client requests a delta sync via `?since=<lastEventId>` query param so it catches up on changes missed during the disconnect window.

**Per-event sequence ID.** Service assigns each emitted event a monotonically-increasing `seq: number` so a reconnecting client can request "everything after seq N". Bounded retention (last 1000 events in memory, ~15 minutes of activity) before the client falls back to a full state refetch.

## 46.4 Conflict resolution

Multiple clients editing the same record concurrently:

**Last-write-wins for scalar fields** (title, category, priority, status, up_next flag). The service applies whichever request arrives last. The losing client receives the `ticket-updated` event with the new value, and (if their UI is currently editing that field) the UI surfaces a non-blocking toast: "Someone else also edited this title. Reload?"

**Append-only for notes.** Notes are immutable once created (today's design); concurrent additions both succeed.

**Optimistic concurrency for risky operations.** Bulk category move, status change with side-effects, restore-from-backup — these accept an `If-Match: <version>` header (or equivalent body field). A mismatch returns 409 Conflict + the current version; the client retries after merging.

**Reuse the existing `ticket_sync` machinery.** The plugin sync engine already handles concurrent-edit semantics for plugin-side mirrors; the same resolver can adjudicate cross-client conflicts.

## 46.5 Auth + trust model

Carry forward from the original §46 v1 + extend:

- Per-project `X-Hotsheet-Secret` header for HTTP (today's behaviour, unchanged)
- Same secret as a query param OR `Sec-WebSocket-Protocol` subprotocol on the WebSocket connect — both accepted; the subprotocol path is preferred (doesn't leak into URL access logs)
- `--bind` opt-in for non-localhost (HS-7940)
- `isTrustedOrigin(origin)` helper covering localhost + Tailscale 100.64.0.0/10 + user-configured `trustedOrigins` (HS-7940)
- HTTPS or WireGuard tunnel for confidentiality on non-localhost transports (deployment-time choice; not in Hot Sheet code)
- WebSocket upgrade requests honour the same origin check + secret check as HTTP

**Per-client identity (deferred).** Today's secret is per-project, not per-client. A v2 could issue per-client tokens (revocable individually) but the operational complexity isn't worth it until a user reports they need it. Tracked as an open question.

## 46.6 Multi-client UX considerations

State that's per-client (DOES NOT broadcast):

- Selection (`state.selectedIds`)
- Active layout (column / list — but current value still persisted per-project as default)
- Search query
- Active project tab (this becomes interesting — see open question §46.10.1)
- Drawer state (open / closed, active terminal tab)
- Detail panel position + size

State that syncs across clients:

- Ticket data (everything in the `tickets` table)
- Notes
- Attachment metadata (the binary blob serving stays HTTP)
- Settings (categories, presets, project-level config — `settings.json`)
- Plugin state visible to the user (sync status indicators, etc.)

**Conflict UI.** Two clients edit the same ticket title concurrently → losing client sees a toast at the bottom of the detail panel: "Brian also edited this. Reload?" with a "Reload" button. If the client isn't currently focused on that field the toast is suppressed and the field updates silently — no point interrupting a user who isn't even looking at it.

**"Who else is here?" indicator.** Optional v2 polish — show a small avatar stack in the top-right indicating other connected clients. Useful for collaboration but introduces an identity concept Hot Sheet currently lacks. Defer.

## 46.7 Tauri co-located mode (single-machine users)

Single-machine users still want the convenience of "double-click the app, your workspace opens" without manually starting a service. The Tauri shell preserves today's flow:

- Spawns a service sidecar (today's `cli.ts` flow, unchanged at the spawn boundary)
- The webview connects to `localhost:<port>` with the same WebSocket sync flow as a remote client
- Quitting the Tauri window stops the sidecar (HS-7931 graceful shutdown applies; HS-7934 e2e covers it)
- Multiple Tauri windows on the same machine connect to the SAME sidecar — second-launch detects the running instance via `~/.hotsheet/instance.json` and the second window points at the existing service instead of spawning its own

The single-machine user with multiple monitors gets multi-client behaviour for free: open Hot Sheet on each screen, both connect to the local service, both see live updates.

## 46.8 Service-only mode

A new `--service-only` CLI flag launches just the Hono server + dataDir + plugins + backup + channel, skipping any Tauri-spawn logic. Used for:

- Headless deployment (NAS, home server, cloud VPS) where users connect from elsewhere
- Server-side automation pipelines that drive the API but never want a UI
- The remote-mode Tauri shell pointing at this instance

`--service-only` implies `--no-open` (no browser opens). The service stays running until killed (SIGTERM via `systemd` / `launchd` / Docker signal) — the HS-7931 graceful-shutdown pipeline applies.

## 46.9 Mobile client (HS-7941)

Same JS bundle, different layout. Separate ticket because the responsive-CSS work is largely orthogonal to the service decoupling. Carries forward from the previous §46 v1 framing:

- PWA manifest for "Add to Home Screen"
- Responsive breakpoint at `(max-width: 700px)`: column → list, sidebar → drawer, detail panel → full-screen sheet, 44pt touch targets
- Terminal drawer hidden on mobile for v1 (terminal access on a phone is plausible but not the headline use case)
- `apple-mobile-web-app-capable` meta tags for the home-screen launch UX

## 46.10 Open questions

1. **Active-project per client vs. shared.** Should a user with three projects open on Client A see the same active-project tab on Client B? Default: per-client. But a "follow other client" mode (mirror their selection) would be useful for the dashboard-on-a-side-monitor use case.
2. **WebSocket auth on Origin-less clients.** `curl -H "Sec-WebSocket-Protocol: hotsheet-secret-<X>"` — does the existing same-origin gate accept this? HS-7940 audit needs to cover it.
3. **Plugin sync engine on multi-client.** The plugin sync (`sync_outbox`, `ticket_sync`) is single-writer today. Multiple clients editing in flight could push concurrent plugin pushes out of order. Audit before HS-7945 ships.
4. **Backpressure.** A noisy mutation source (bulk import, demo mode seed) could flood the WebSocket. Service should batch events (e.g. coalesce 50 rapid `ticket-updated` into a single `ticket-batch-updated`) above a threshold.
5. **Offline mobile cache.** A service-worker cache of the last-seen state would let the mobile client keep showing tickets when the WiFi flickers. Out of scope for v1; revisit after HS-7945 ships.
6. **Multi-user identity.** Hot Sheet has no concept of users today. Multi-client doesn't require it (per-project secret is the trust boundary). But "who edited this" for the conflict UI implies SOMETHING. Could derive a stable per-client ID from a localStorage UUID + display it as "Client at <ip>" or "Client #abc123". Defer until users actually need it.
7. **Terminal multi-client read access.** Terminal PTYs live server-side. Multiple clients connecting to the same terminal would each get a copy of the output stream — but only one client can hold the input focus at a time without producing chaos. Open question: do we mirror output to all connected clients (read-only on N-1, writable on the focused client) or only stream to one client at a time?

## 46.11 Phased implementation

1. **HS-7940 (existing)** — server-side: `--bind <address>`, `isTrustedOrigin`, GET-secret enforcement on non-trusted origins. Independent of decoupling work; ships first; unblocks the rest.
2. **HS-7944 (new)** — service-only mode (`--service-only` flag) + Tauri shell remote mode (`--service-url <url>` flag, in-app Settings → "Use remote service URL"). The Tauri co-located mode stays the default.
3. **HS-7945 (new)** — WebSocket push replacing `/api/poll`. Event types per §46.3, heartbeat protocol, exponential-backoff reconnect, sequence-ID-based delta-sync, fallback to polling on connect failure.
4. **HS-7946 (new)** — multi-client conflict UX: detection of concurrent edits, "X also edited this" toast, optimistic-concurrency `If-Match` headers on risky operations, plugin sync engine audit.
5. **HS-7941 (existing)** — PWA manifest + mobile-responsive layout. Can ship in parallel with HS-7945; doesn't depend on the service detach.
6. **HS-7942 (existing)** — Tailscale UX sugar (detect tailnet IP, surface "Open on iPhone" QR in Settings). Lower priority post-decoupling — once the service is detached, Tailscale becomes one of several deployment patterns and the convenience layer matters less.

## 46.12 Cross-references

- §1 — overview + tech stack (Hono, port 4174, dataDir layout)
- §2 — `settings.json:secret` provenance + lifecycle
- §9 — REST API endpoint reference (the surface receiving the WebSocket sibling)
- §10 — Tauri desktop wrapper + the localhost assumption being relaxed
- §18 — plugin sync engine (the existing single-writer model that HS-7945 + HS-7946 audit)
- §22 — terminal drawer (terminal PTYs are server-side; multi-client read-only access to the same terminal is an open question §46.10.7)
- §37 — quit confirmation (relevant when one client of many issues a shutdown)
- §45 — graceful shutdown (open question — stale long-poll / WebSocket sockets shouldn't deadlock close)
