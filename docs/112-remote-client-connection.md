# 112 — Remote-Client Connection (mount a remote Hot Sheet project as a tab)

> **Status:** Design only (HS-9193). Captures the **client** half of the §94 mutual-TLS remote-access epic: connect the client to a *remote* Hot Sheet server, authenticate over mTLS, enumerate its projects, and mount one (or several) as a tab. The **server** half is fully shipped (see §112.2); this is purely additive client work against a real, handshake-ready server. Implementation is decomposed into follow-up tickets (§112.10). Prerequisite for **HS-9164** (the "+ → local | remote" project-add picker) and **HS-9160** (the setup guide) — the maintainer confirmed the sequencing: build this foundation first, then HS-9164 is a thin layer on top.
>
> Cross-refs: [94-strong-remote-auth.md](94-strong-remote-auth.md) (the mTLS architecture + locked decisions), [97-self-hosting-mtls.md](97-self-hosting-mtls.md) (the operator guide), [46-service-client-decoupling.md](46-service-client-decoupling.md) (per-client vs per-project state), [93-websocket-push-sync.md](93-websocket-push-sync.md) (`/ws/sync` push + reconnect/backoff), [8-cli-server.md](8-cli-server.md) §8.2.1 (`--server` modes, HS-9163).

## 112.1 Problem

Today the Hot Sheet client only ever talks to its **own localhost server**. Every request is same-origin: the API transport builds relative `/api/...` URLs, and the `/ws/sync` + terminal WebSockets are built from `window.location.host` (§112.4). The project registry (`GET /api/projects`, `.hotsheet/settings.json`) is always **local** — a `ProjectInfo` carries a local filesystem `dataDir`, not a remote origin. There is no path to point the client at a *remote* Hot Sheet server, authenticate to it, and mount one of its projects as a tab.

HS-9163 shipped the **server** side (`--server remote-access` / `--bind` over mTLS). This doc specifies the missing **client** side.

## 112.2 What's already shipped — do NOT re-litigate (server side, §94/§97)

The entire mTLS server model is **decided and implemented**. HS-9193 builds against it; it changes none of it.

- **Two tiers, keyed mechanically off the bind** (§94.5): **Tier 0 = localhost** (default) stays plain HTTP + per-project shared secret. **Tier 1 = exposed** (`--bind` off-loopback / `--server remote-access`) requires **mTLS + per-device client certs + ACLs**. An exposed server that can't set up its CA **refuses to start** (never serves plaintext).
- **In-process Node TLS** — Hot Sheet owns the CA + certs end-to-end (`requestCert:true` + `rejectUnauthorized:true`). The TLS 1.3 handshake **is** the challenge-response; no app-layer challenge crypto.
- **Per-project CA** — each project's self-signed CA (keychain, or `HOTSHEET_CA_PASSPHRASE` file store) signs the server cert + one client cert per device. Identity: `CN = label` + SAN URI `hotsheet://client/<id>`. ACLs v1 = "enrolled + not-revoked = full access"; revocation checked per-connect (+ the ~30 s WS revocation sweep, HS-9025).
- **Enrollment: `.p12` import first, then QR pairing.** Shipped modules: `src/auth/ca.ts`, `tlsListener.ts`, `deviceRegistry.ts`, `authz.ts`, `pairingTokens.ts`, `caFileStore.ts`; routes `src/routes/enrollment.ts` (mint / sign-csr / list / revoke, credential-creation loopback-only) + QR `pair/start` (loopback) / `pair/complete` (token-gated). Operator UI: Settings → **Remote Access** (`devicesSettings.tsx` — Add Device… → `.p12`, list, revoke; **Pair a Device…** → QR). Device-side `/pair` page (`pair.tsx`).
- **Tunnel-only pairing is permanent** (§94.13, HS-9054): enrolling a new device happens **before** exposing, or **over a tunnel** — relaxing `rejectUnauthorized` for an on-port LAN carve-out was explicitly rejected (it moves auth off the fail-closed handshake). This is a *requirement HS-9193 inherits*, not a gap.
- **A mounted remote project carries its own `(origin, secret)` pair; the per-project `secret` is the lease/bus key.** Locked as a maintainer decision (2026-06-29, docs/109 §109.3) precisely to fit this future multi-server client. HS-9193 inherits it.

**Key implication for the credential:** over `fetch` / `WebSocket`, the browser/WKWebView presents the installed `.p12` **natively** on the TLS handshake for the target origin — the app code does **not** send the cert. §97.3's whole client story today is "browse to `https://<host>:4174` and pick the certificate when prompted." So HS-9193's app-code work is mostly **routing requests to a remote origin**; the cert presentation is the platform's job (with a real open question for the Tauri build — §112.5).

## 112.3 The remote-project model

A remote project is a `ProjectInfo` whose data lives at a **remote origin** rather than a local `dataDir`. Concretely:

- **`ProjectInfo` gains an optional `origin`** (e.g. `https://host:4174`). When present, the project is remote: the four URL builders (§112.4) target `origin` instead of same-origin, and the project's `secret` is the remote server's per-project secret (obtained during enumeration, §112.7). When absent, the project is local exactly as today.
- **Where the remote registry lives.** Remote servers/projects are **not** tied to any one local project's `.hotsheet/` — a client with zero local projects can still connect to a remote. They belong in a **machine-global** store: a new `~/.hotsheet/remotes.json` (mirroring the existing `~/.hotsheet/config.json` global config), holding `{ servers: [{ origin, label, deviceClientId?, projects: [{ secret, name }] }] }`. (See §112.9 open decision O1.)
- **Prune exemption.** `GET /api/projects` auto-prunes registry entries whose `dataDir` doesn't `existsSync` (`routes/projects.ts`). A remote project has no local dir — it must be **exempt** from that prune (it's carried in the global remotes store + merged into the tab list client-side, not registered via the local `POST /api/projects/register` path).
- **The store/tabs UI is generic already** (`projectsStore.ts` `defineStore` over `ProjectInfo[]`, keyed by `secret`; `projectTabs.tsx` renders per entry). Remote projects slot in as additional entries — no rebuild of the tab machinery.

## 112.4 Remote-aware transport (the four same-origin builders)

Every client→server address is currently same-origin. Each must become **origin-aware**: use the active project's `origin` when remote, else same-origin as today.

| Surface | Site | Change |
|---|---|---|
| API transport | `src/client/api.tsx` `buildUrl` / `buildHeaders` (injected via `setApiTransport` in `app.tsx`) | Prefix `origin` for a remote project instead of relative `/api`. |
| WS push | `src/client/wsSync.ts` `buildWsUrl` (`${protocol}//${window.location.host}/ws/sync`) | `wss://<origin-host>/ws/sync` for a remote project. |
| Terminal WS | `src/client/terminalCheckout.tsx` terminal-WS URL | Same origin swap. |
| Image proxy | `src/client/imageProxy.tsx` (`window.location.origin`) | Same origin swap. |

The typed runner `src/api/_runner.ts` is already origin-agnostic (it calls the injected transport with a path), so the injection point + `buildUrl`/`buildHeaders` are the single choke for the API layer. The shared secret is **still sent** (harmless; on Tier 1 the server gates on the cert via `authz.ts`, not the secret). **Scope + verify** the §46/§93 transport can address a remote origin end-to-end before wiring the UX — that verification is its own follow-up (§112.10).

## 112.5 Client-cert presentation

- **Browser (web) client:** the `.p12` lives in the OS/browser cert store; the browser presents it natively on the mTLS handshake for the remote origin. No app code. This is the §97.3 path and works today.
- **Desktop (Tauri) client — investigated (HS-9306, see §112.5.1).** The app runs in a platform WebView (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux). **Finding: none present a client cert "for free" from within Tauri**, and WKWebView — the primary macOS target — is specifically broken for the *subresource/WebSocket* requests Hot Sheet's remote transport uses. **Recommendation: a Rust-side mTLS proxy** (Option 2). The self-hosted, single-user scope (§94.4) keeps the blast radius small.

### 112.5.1 WebView client-cert feasibility (HS-9306)

Hot Sheet's remote transport is entirely **`fetch` + WebSocket** (subresources), NOT a top-level page navigation — this distinction is what breaks the "just let the WebView present the cert" hope on macOS.

| WebView (platform) | Client-cert on outbound mTLS? | Mechanism | Verdict |
|---|---|---|---|
| **WKWebView (macOS)** | Main navigation: yes via `webView(_:didReceive:completionHandler:)` (`NSURLAuthenticationMethodClientCertificate`). **Subresources (fetch/XHR/WebSocket): broken** — reported 403s; cert also gets cached; the documented workaround is intercepting via `NSURLProtocol`/a custom `URLSession`. | Requires a `WKNavigationDelegate` the app owns — **Tauri does not expose it**, and even with it, subresource requests don't reliably surface the challenge. | ❌ Not viable for our fetch/WS transport without native interception. |
| **WebView2 (Windows)** | Yes — `CoreWebView2.ClientCertificateRequested` pulls from the Windows cert store; host can auto-select or fall back to a dialog. Works for subresources (Chromium). | Requires host-side COM handling of the event — **not exposed by Tauri today**; known cert-selection bugs (esp. smartcards). | ⚠️ Possible with a WebView2-specific integration; not free. |
| **WebKitGTK (Linux)** | Yes — `WEBKIT_AUTHENTICATION_SCHEME_CLIENT_CERTIFICATE_REQUESTED` via the `authenticate` signal + `webkit_authentication_request_authenticate()`. | Requires host-side signal handling — **not exposed by Tauri**; relatively recent support. | ⚠️ Possible with a WebKitGTK-specific handler; not free. |

**Common thread:** every platform needs bespoke, per-WebView host wiring Tauri doesn't surface, the three mechanisms are entirely different, and the primary target (WKWebView) fails for exactly our request shape. So Option 1 (native store as-is) and Option 3 (per-WebView picker/hook) are each a **three-platform native-integration project** with a broken macOS leg.

**Recommendation — Option 2, a Rust-side loopback mTLS proxy** (portable, one implementation, sidesteps every WebView's cert handling):
- The Rust side holds the client cert/key (loaded from the OS keychain — §20 secure storage — or an imported `.p12`) and makes the **outbound** mTLS calls: `reqwest` with a `rustls` client-auth config for `https://`, and a rustls-backed WebSocket client (e.g. `tokio-tungstenite`) for `wss://`.
- It exposes a **loopback plain-HTTP/WS endpoint** (127.0.0.1, ephemeral port, per-remote-origin) that the WebView hits; the client's origin-aware transport (HS-9302) points a remote project at that loopback endpoint instead of the remote origin directly when running under Tauri.
- **Security:** the proxy binds loopback-only (same trust boundary as the Tier-0 local server); the mTLS handshake + cert validation still happen in-process on the Rust side against the remote's per-project CA. No plaintext leaves the machine.
- **Cost:** new Rust deps (`reqwest` + `rustls` + `tokio` + a WS client — none present today; `src-tauri/Cargo.toml` currently has only tauri plugins + `rfd`/`serde`), a small proxy module in `src-tauri/`, and a Tauri command to start/stop a proxy for a given remote origin + return its loopback URL. The **web** client is unaffected (browser presents the cert natively, §97.3) — the proxy is a Tauri-only path.

**Validation spike still needed** before committing: stand up an exposed `--server remote-access` Hot Sheet, mint a `.p12`, and prove a `reqwest`+`rustls` client-auth `GET /api/projects` **and** a `tokio-tungstenite` `wss://.../ws/sync` both complete the handshake against the per-project CA. Tracked as a follow-up.

## 112.6 Connection entry (UX)

A **"Add remote server"** flow (the primitive HS-9164's picker will invoke):

1. **URL entry** — `https://host:port`, validated + normalized to an origin.
2. **QR scan** — reuse the shipped `@zxing/browser` scanner (HS-9097) to read a pairing/connection QR that carries the URL (+ enrollment material). Pairing itself is the shipped `/pair` flow (§94/§97); this is the *client-initiated* counterpart.
3. **Credential** — import a `.p12` (the same `saveBytes`/file-picker infra in reverse — a *load*), or complete QR-driven enrollment that provisions the device cert. Surface the device-cert lifecycle (which device, revoke) consistent with §94's per-project CA + ACLs. NOTE: today's Remote Access tab mints certs *for other devices to install*; a **client** consuming a cert to *connect* is new (§112.9 O2 covers where that cert lives for the Tauri build).

The web path can lean on the browser's native cert store + a plain navigation for the first cut; the in-app "mount as a tab without leaving the page" flow is the richer target.

## 112.7 Remote project enumeration + multi-select

After a successful handshake, call the remote server's project list (`GET /api/projects` on the remote origin, presenting the cert). If multiple projects are available, let the user **multi-select** which to add (mirrors HS-9158's "yes, support batch enrollment" conclusion + HS-9164's "select which to add"). One device cert can cover several of a server's projects (per-project CAs by default; opt-in shared-trust per HS-9158). Each selected project becomes a remote `ProjectInfo` (`origin` + that project's `secret`) persisted to the remotes store (§112.3) and added as a tab.

## 112.8 Connectivity state

Surface **connected / reconnecting / unreachable** per remote project. This rides the §93 `/ws/sync` reconnect + exponential backoff already in `wsSync.ts` (`backoffDelay` / `shouldFallback`) — extended to report a per-project connectivity signal rather than only the global "live updates unavailable" hint. Feeds HS-9164's monitor-cloud vs cloud-alert tab icon. A remote project that's unreachable shows its last-known state read-only + a reconnecting indicator, not an error tab.

## 112.9 Open decisions (maintainer)

- **O1 — remote registry storage.** Recommend a machine-global `~/.hotsheet/remotes.json` (a remote isn't tied to a local project's `.hotsheet/`). Confirm vs. an alternative (e.g. folding into `~/.hotsheet/config.json`, or a per-local-project association).
- **O2 — Tauri client-cert presentation** (§112.5). **Investigated (HS-9306) — recommendation: the Rust-side loopback mTLS proxy** (§112.5.1). The WebViews can't do it portably (WKWebView is broken for our fetch/WS subresource requests; WebView2/WebKitGTK each need bespoke native wiring Tauri doesn't expose). The maintainer's remaining call: **accept the Rust-proxy direction** (then the validation spike + implementation follow-up runs), or fund the three-platform native-integration path instead.
- **O3 — first-cut scope.** Recommend the **web** remote client first (native cert store, lowest new surface), with the Tauri path gated on O2. Confirm whether the desktop path must land in the same pass.
- **O4 — terminal WS over a remote origin.** Mounting a remote project's *terminals* (per-project PTYs, §22) over `wss://` is heavier than data sync. Recommend Phase-2: land remote **data** (tickets + `/ws/sync`) first, remote **terminals** second. Confirm.

## 112.10 Build plan (follow-up tickets)

Decomposed so each phase is independently reviewable; the security-sensitive transport is isolated from the UX.

1. **Remote-`ProjectInfo` shape + remote-aware transport** — add `origin` to `ProjectInfo`; make the four URL builders (§112.4) origin-aware; the `~/.hotsheet/remotes.json` store + merge into the tab list + prune exemption. **Scope + verify** the transport can address a remote origin end-to-end (a real exposed server). *The foundation everything else builds on.* **SHIPPED (HS-9302, web-first):** `ProjectInfo.origin?` (`state.tsx`); pure origin resolution in `src/client/remoteOrigin.ts` (`apiBaseOrigin` with a **control-plane vs data-plane** split — `/projects`, `/remotes`, `/global-config` stay LOCAL even when a remote project is active; `httpOriginToWs` for `wss://`); wired into all four builders (`api.tsx` `buildUrl`, `wsSync.ts` `buildWsUrl`, `terminalCheckout.tsx` terminal-WS, `imageProxy.tsx`) — each returns same-origin unchanged for a local project. Remotes store: `src/remotes.ts` (fs read/write of `~/.hotsheet/remotes.json`, mirrors `global-config.ts`) + `RemotesFileSchema` SSOT (`routes/validation.ts`) + `GET`/`PUT /api/remotes` (`routes/remotes.ts`) + typed callers (`api/remotes.ts`); the client merges remote projects into the tab strip (`projectTabs.tsx::remoteProjectInfos`, failure-open). **The prune exemption is moot** with this separate-store design — remote projects never enter `GET /api/projects` (local registry only), so the `existsSync` prune can't touch them. Tests: `remoteOrigin.test.ts` (the control-plane/data-plane matrix + `wss://` mapping), `remotes.test.ts` (store round-trip), `routes/remotes.test.ts` (GET/PUT). **The real-server end-to-end mTLS handshake verification is a manual acceptance step** (can't be done headlessly — maintainer-agreed 2026-07-03; see §112.9 O2/O3). Cross-origin CORS + the browser's native cert presentation are validated in that manual step.
2. **Connection entry UX** (§112.6) — the "Add remote server" modal (URL + QR), credential import/provision, device-cert lifecycle surface. **Web-first CORE SHIPPED (HS-9303):** `src/client/remoteUrl.ts` (pure `normalizeServerUrl` → canonical origin; scheme-less defaults to https; `isLoopbackOrigin` nudge), `src/client/remoteServers.ts` (pure `upsertServer`/`removeServer` — a re-add preserves already-enumerated projects — + `addRemoteServer`/`removeRemoteServer` read-modify-write over `GET`/`PUT /api/remotes`), the `src/client/addRemoteServerDialog.tsx` modal (URL entry → validate → persist → `refreshProjectTabs` + toast; a cert note that the browser presents the installed cert natively), wired to the toolbar context menu ("Add Remote Server…"). Tests: `remoteUrl.test.ts`, `remoteServers.test.ts`. **Deferred to HS-9308:** the QR-scan (reuse the `@zxing` scanner from `pair.tsx`) + in-app cert enrollment/`.p12` import (web leans on the browser's native store; the Tauri path is HS-9307).
3. **Remote project enumeration + multi-select** (§112.7) — enumerate the remote's projects, multi-select, persist + mount as tabs. **SHIPPED (HS-9304):** `remoteServers.ts::fetchRemoteProjects(origin)` (cross-origin `GET <origin>/api/projects`, browser presents the cert; tolerant zod parse → `{name, secret}[]`, injectable `fetch` for tests) + `mountRemoteProjects(origin, label, selected)` (force-replaces the server's projects). The `addRemoteServerDialog` gained a **two-phase flow**: URL → **Connect** (enumerate) → **multi-select checkboxes** (all checked by default) → **Mount selected** → persist + `refreshProjectTabs`. Enumeration failure (cert not installed / unreachable) degrades gracefully to "Add server anyway" (persist with no projects, mount later). Tests: `remoteServers.test.ts` (fetch mapping / non-2xx / bad-shape / URL). The real-server enumeration handshake is part of the manual acceptance step (HS-9302).
4. **Connectivity state** (§112.8) — per-remote-project connected/reconnecting/unreachable off the §93 reconnect; feeds HS-9164. **SHIPPED (HS-9305):** `src/client/remoteConnectivity.ts` — a per-secret connectivity signal (`setConnectivity`/`getConnectivity`/`connectivity()`; `'connected' | 'reconnecting' | 'unreachable' | 'unknown'`, map-replaced on real change so tab-indicator `effect`s fire). `wsSync.ts` reports it off its own reconnect: `markConnected` → `connected` for the connected project, `onDisconnect` → `reconnecting` (transient) or `unreachable` (once `shouldFallback` trips), recovery → `connected`. Tests: `remoteConnectivity.test.ts` (store), `wsSync.test.ts` (the connected→reconnecting→unreachable→connected transition). **The visual tab indicator that consumes this signal is HS-9164** (the monitor-cloud vs cloud-alert icon) — this ships the signal it reads.
5. **Investigation — Tauri client-cert presentation** (§112.5 / O2) — determine how the desktop WebView presents the client cert on outbound `wss://`/`https://` per platform (WKWebView / WebView2 / WebKitGTK); recommend the mechanism (native store vs. Rust-side mTLS proxy vs. picker).

HS-9164 (the "+ → local | remote" picker) and HS-9160 (the setup guide) layer on top of #1–#4.
