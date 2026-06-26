# 94. Strong Remote Authentication (mTLS + per-client identity)

HS-8985. A security-architecture design for authenticating remote access to the Hot Sheet
service with real cryptographic mutual auth, replacing/augmenting today's single per-project
shared secret. Motivated by the user's directive on HS-8983: the remote surface "is very likely
to be a popular attack surface... we ideally need something like HTTPS mutual auth and strong
challenge-based public-private-key authentication... every request authenticated and validated
before execution."

> **Status (2026-06-24):** Design **decided** (the §94.8 forks are answered). Decomposed into
> phased implementation sub-tickets (§94.10), ready to schedule. **Decisions:** mTLS (no custom
> challenge layer — the TLS handshake IS the challenge-response); **in-process Node TLS** (Hot Sheet
> owns the CA + certs end-to-end); **localhost/single-user stays exactly as today (shared secret) —
> mTLS engages ONLY when the server is not on localhost** (exposed); **self-hosted scope only** (the
> §88 hosted cloud will add OIDC/SSO separately); enrollment via **`.p12` import first + QR** (for
> the future mobile-web client).
>
> **Implementation progress:** sub-tickets **1/6 (HS-8992)** + **2/6 (HS-8993)** + **4/6 (HS-8995)**
> SHIPPED; **3/6 (HS-8994)** + **5/6 (HS-8996)** server cores SHIPPED (client UI → HS-9024/HS-9026).
> Modules: `src/auth/ca.ts` (CA + cert lifecycle), `tlsListener.ts` (exposed-only mTLS listener),
> `deviceRegistry.ts`, `routes/enrollment.ts` (mint `.p12` / sign CSR / list / revoke / QR-pair,
> loopback-gated), `authz.ts` (Tier-1 cert authz + revocation; secret demoted to defense-in-depth),
> `pairingTokens.ts` (single-use QR tokens). Only **6/6 (HS-8997 threat-model sign-off + security
> re-audit)** remains — now unblocked. Follow-ups now SHIPPED: **HS-9019** (keychain-less CA via
> `HOTSHEET_CA_PASSPHRASE` → encrypted `auth-ca.enc`, `src/auth/caFileStore.ts`), **HS-9024** (Settings
> → Remote Access device UI `src/client/devicesSettings.tsx` + Tauri `save_file`), **HS-9025** (WS
> revocation re-check sweep `src/auth/wsRevocationSweep.ts`), **HS-9026** (QR pairing desktop display
> `src/client/devicesPairing.tsx`), **HS-9033** (the **device-side pairing page** — standalone
> secret-free `/pair` surface, `src/components/pairPage.tsx` + `src/client/pair.tsx`: scan
> (`BarcodeDetector`) / paste the payload → in-browser RSA keypair + CSR via node-forge
> (`src/client/pairing/devicePairing.ts`, private key never leaves the device) → POST
> `/api/auth/pair/complete` → assemble + download a chain-complete `.p12` + per-platform install help).
> HS-9033 also closed two bootstrapping gaps that blocked the device end: `pair/complete` is now
> **exempt from the shared-secret middleware** (the single-use token is its sole credential — an
> enrolling phone has neither secret nor cert), and that endpoint now **returns `caCertPem`** so the
> device can chain its `.p12` and trust the server CA. **Pairing runs over the trusted/tunnel channel**
> (the exposed mTLS port rejects an unenrolled device at the TLS handshake); an on-port LAN handshake
> carve-out is a tracked follow-up. The only remaining manual work is the **per-platform cert install**
> (iOS profile / Android / desktop keychain / Firefox store), a manual-test-plan item. See §94.10 + docs/97.

## 94.1 Why now

The medium/long-term direction (the §88 cloud service / teams + orgs, HS-8878; the §46
multi-client decoupling; remote workers driving real code changes via the distributed-execution
epic §90) all point at a service that is reachable off-box and acts on authenticated requests with
real authority (it runs shell commands, drives terminals, edits tickets, holds plugin OAuth
tokens + keychain secrets). That is a high-value target. The current model is appropriate for a
single user on a private tailnet; it is **not** sufficient for broad exposure or multi-user.

## 94.2 Where we are today (the interim baseline)

- **Shared secret** — one per-project `X-Hotsheet-Secret`. Possession = full authority over that
  project. No per-client identity, no revocation per device, no expiry.
- **Origin/bind gate (HS-7940)** — default loopback bind; `--bind` opts into off-box; on an
  exposed server, GETs from untrusted origins require the secret + a `trustedOrigins` allow-list
  gates same-origin no-secret mutations. **OTLP `/v1/*` gated (HS-8983)** — loopback / trusted /
  secret.
- **Transport confidentiality** is deployment-provided — the recommended path is a
  Tailscale/WireGuard tunnel (WireGuard gives both encryption AND peer auth at the network layer).
  Plain HTTP otherwise.

**Gaps for a broadly-exposed / multi-user service:**
1. No transport security without an external tunnel (plaintext secret on the wire).
2. The secret is a bearer token: stolen once (logs, a screenshot, a malicious browser extension,
   a backup) = total compromise, with no per-device revocation and no expiry.
3. No client identity → no per-user/per-device authz, no audit trail, no ACLs (needed for §88
   teams/orgs).
4. No replay/MITM protection beyond the tunnel.

## 94.3 Threat model

Actors, by position:

- **On-path network attacker** (LAN, hostile WiFi, a compromised router between client + server) —
  can read/modify plaintext, replay requests, attempt MITM.
- **Remote internet attacker** (server bound to `0.0.0.0` / port-forwarded / on a public cloud) —
  can connect directly; tries credential theft, brute force, exploitation of any open endpoint.
- **Malicious co-tenant on the tailnet** — a less-trusted device on the same tailnet.
- **Bearer-token thief** — obtains the shared secret out-of-band (logs, backup, shoulder-surf, a
  malicious browser extension / page reading it from storage) without ever being on-path.
- **Cross-site attacker** — a malicious web page the user visits tries CSRF / CSWSH against a
  reachable instance.

Assets: ticket data, the shell/terminal execution surface (RCE-equivalent authority), plugin OAuth
tokens + keychain secrets, telemetry, the ability to dispatch work to remote workers.

Properties we want:
- **Confidentiality + integrity on the wire** (TLS), independent of an external tunnel.
- **Mutual authentication** — the server proves its identity to the client AND the client proves a
  per-device identity to the server, via possession of a private key (not a replayable bearer
  token).
- **Replay + MITM resistance** — bound to the TLS channel.
- **Per-device identity + revocation + expiry.**
- **Authorization before execution** — every request mapped to an identity + its permitted scope
  before any handler runs (no open path on an exposed server; HS-7940 GET-lockdown is the interim).

## 94.4 Proposed architecture: mutual TLS (mTLS)

The user named the target precisely: HTTPS mutual auth + challenge-based public/private-key auth.
**mTLS is exactly that, and it already provides the "challenge-response" natively** — during the
TLS handshake the client signs the handshake transcript with its private key (TLS 1.3
`CertificateVerify`), proving possession of the key tied to its certificate, bound to that specific
channel. **We should NOT hand-roll a separate challenge protocol on top of TLS** — custom crypto
auth is a classic source of severe bugs, and mTLS gives us the property for free, standardized and
audited.

### 94.4.1 The model

- **Per-project Certificate Authority.** Each project (or the global instance) holds a small CA
  (a self-signed root key pair, stored in the keychain like other secrets, §20). It signs:
  - The **server cert** (presented on every TLS connection; the client pins/trusts the project CA).
  - One **client cert per enrolled device**, carrying that device's identity (a stable client id +
    a human label) in the subject / a SAN.
- **mTLS handshake.** The Node TLS server is configured with `requestCert: true` +
  `rejectUnauthorized: true` against the project CA. A connection without a CA-signed client cert
  is rejected at the TLS layer — before any HTTP handler runs. The authenticated client identity is
  read from `socket.getPeerCertificate()`.
- **Authorization.** The verified client identity → an ACL lookup (per-project roles; the §88
  teams/orgs model). Every request is authn'd (the TLS layer) AND authz'd (the ACL) before
  execution. The shared-secret path is removed on an mTLS listener (or kept only for loopback).
- **Revocation.** A per-project revocation list (revoked client-cert serials) checked on connect;
  revoking a device is immediate. Certs carry an expiry (re-enroll on rotation).

### 94.4.2 Enrollment (DECIDED — `.p12` import first, then QR)

How a device gets its client cert. **Phase 1: `.p12` import** — the self-hosting admin generates a
client cert (the desktop app's CA signs one + exports a password-protected `.p12`, or imports an
externally-generated one) and installs it on the connecting device/browser. No pairing flow; the
right first cut since the only clients today are desktop/browser, not mobile.

**Phase 2: QR pairing** — the desktop app shows a short-lived pairing QR (mirrors the §46/HS-7942
"Open on iPhone" QR); a device scans it, generates a key pair, sends a CSR over the trusted/tunnel
channel, and the server signs + returns the cert. Added for when the §46 client/server split + the
responsive mobile-web client land, so phones can enroll as clients without a desktop `.p12` dance.

### 94.4.3 Transport: in-process TLS (DECIDED — option A)

**Chosen: in-process Node TLS.** Hot Sheet owns the CA + certs + mTLS end-to-end via Node's
`https`/`tls` server with `requestCert: true` + `rejectUnauthorized: true`. Self-contained (no extra
deps, no reverse-proxy setup), works for the Tauri sidecar + headless, turnkey for the self-hosting
user. The cost — more crypto in our security-critical path — is accepted; it's bounded (cert
lifecycle + the listener config) and the HS-8987 security skill re-audits it each release. The
`@hono/node-server` `serve()` accepts a `createServer`/TLS options path, so the existing server
plumbing (HS-7940's `hostname` bind) extends to a TLS listener on the exposed (Tier-1) path.

(A reverse-proxy deployment — Caddy/nginx terminating mTLS + passing the identity over loopback —
stays a *documented option* for users who already run one, but is not the primary path.)

## 94.5 Tiers (don't force mTLS on the hobbyist)

**DECIDED — two tiers, keyed off whether the server is on localhost.** A single user on localhost
should not need a CA + per-device certs.

- **Tier 0 — localhost (today, UNCHANGED).** Default loopback bind + the per-project shared secret.
  The user was explicit: *"for users on localhost — the single user case — you can leave it as is."*
  No mTLS, no certs, zero new friction for the overwhelmingly-common case.
- **Tier 1 — not on localhost (mTLS REQUIRED).** *"mTLS is only when localhost isn't used."* The
  moment the server is reachable off-box (`--bind` non-loopback), mTLS + per-device client certs +
  ACLs are required — not optional. The HS-7940 GET-lockdown / origin gate / shared-secret path is
  superseded by mTLS on this tier (kept only as defense-in-depth, not the primary credential).

So the trigger is mechanical: loopback ⇒ Tier 0 (as today); exposed ⇒ Tier 1 (mTLS). A tunnel
(WireGuard/Tailscale) is a confidentiality layer the user may still add under either tier, but it no
longer substitutes for mTLS once the server is exposed.

## 94.6 Relationship to existing tickets

- **HS-7940** (bind + origin gate) / **HS-8983** (otel gate) — the interim hardening; the
  GET-lockdown + origin checks remain as defense-in-depth under Tier 1.
- **HS-7946** (per-client identity / clientId registry) — subsumed: the client cert IS the
  cryptographic per-client identity. The clientId registry becomes the enrolled-device registry.
- **HS-8986** (request hardening — size caps, rate limits, schema bounds) — sibling; independent of
  the auth model and should land regardless (defense-in-depth even under mTLS).
- **HS-8987** (security-review skill) — the standing mechanism that re-audits this surface each
  release.
- **HS-8878 / §88** (cloud service, teams + orgs) — **out of scope here (DECIDED).** This epic is
  **self-hosted exposure only**; the user: *"this is for self hosting specifically. once we have a
  cloud solution we'll likely need some additional options."* The hosted cloud will add its own auth
  (likely OIDC/SSO + sessions) as a separate effort; the ACL/identity model built here is reusable,
  but the mTLS primary is the self-hosted answer, not the cloud one.

## 94.7 Phasing (once the model is chosen)

1. **CA + cert lifecycle** — generate/store the per-project CA + server cert (keychain); a
   `src/auth/ca.ts`. No wire change yet.
2. **In-process mTLS listener** (or the reverse-proxy header contract) — `requestCert`, peer-cert →
   identity, behind a flag; loopback/Tier-0 unchanged.
3. **Enrollment flow** — CSR signing endpoint (local/paired only) + the desktop pairing-code/QR UX.
4. **Authz + ACLs** — map identity → permitted scope; remove the bearer-secret path on the mTLS
   listener; revocation list.
5. **Docs + threat-model sign-off** + the HS-8987 skill re-audit.

## 94.8 Decisions (answered 2026-06-24)

1. **mTLS confirmed** — yes. The TLS 1.3 handshake's `CertificateVerify` IS the challenge-response;
   **no hand-rolled application-layer challenge** on top.
2. **Transport** — **(A) in-process Node TLS.** Hot Sheet owns the CA + certs + mTLS end-to-end.
3. **Tiers** — **localhost stays as today (shared secret); mTLS engages only when not on localhost
   (exposed).** Mechanical trigger off the bind.
4. **Scope** — **self-hosted exposure only.** The hosted cloud (§88) is a later, separate effort
   with its own auth options.
5. **Enrollment** — **`.p12` import first** (no mobile clients yet), **plus QR pairing** added for
   the future client/server split + responsive mobile-web client.

## 94.10 Decomposition (implementation sub-tickets)

Phased so each security-critical piece gets its own ticket + review. Dependencies via `blocked_by`.

1. **CA + cert lifecycle** (`src/auth/ca.ts`) — generate/load a per-project self-signed **CA**
   (keypair in the keychain, §20) + a **server cert** it signs; helpers to sign a **client cert**
   from a CSR / public key, export a password-protected **`.p12`**, and read a cert's identity
   (stable client id + label). Pure crypto + keychain I/O, no wire change. **No dep on the rest.**
   **SHIPPED (HS-8992).**

   **Library decision (made here):** Node's built-in `crypto` can generate keypairs and *parse*
   X.509 but **cannot build/sign a certificate, generate/sign a CSR, or export PKCS#12** — the
   three operations this module needs. So a library is required. Chosen: **`node-forge`
   (`^1.3.1`)** — a single, mature, pure-JS package covering cert signing + CSR + PKCS#12 in one
   dependency (vs `@peculiar/x509`, which needs `@peculiar/asn1-pkcs12` + manual assembly for the
   `.p12` half); pure JS so it bundles into the server tsup output with no native-addon /
   runtime-external juggling; clean `npm audit`. Native `crypto.generateKeyPairSync` still does the
   keygen (fast); forge only assembles/signs/exports. Recorded in `docs/dependency-security.md`.

   **What shipped:** `generateCa` / `signServerCert` / `signClientCert` / `signClientCsr` /
   `exportClientP12` / `readP12` / `readIdentity` / `readIdentityFromPeerCertificate` /
   `verifyClientCert` (pure crypto) + `loadOrCreateProjectCa` / `loadProjectCa` / `clearProjectCa`
   (keychain-backed, namespaced per project via `projectCaId(dataDir)` under keychain plugin id
   `auth`). Identity model: subject **CN = human label**, a SAN URI `hotsheet://client/<id>` carries
   the **stable client id**. CA stored as two keychain entries (`ca-key:<projectId>` +
   `ca-cert:<projectId>`); `loadOrCreateProjectCa` throws (and rolls back) if the keychain can't
   persist — an mTLS deployment requires a *durable* CA. Tests (`src/auth/ca.test.ts`, 19) cover the
   pure-crypto round-trips (chain validation, identity round-trip, `.p12` re-import + wrong-password
   rejection, CSR signing + bad-CSR rejection), an **end-to-end Node `tls` mTLS handshake** (trusted
   client connects + identity reads off the live `getPeerCertificate()`; a foreign-CA client is
   rejected — de-risks sub-ticket 2), and keychain-backed persistence (mocked keychain).
2. **In-process mTLS listener** — on the exposed (Tier-1) path, stand up the Node TLS server with
   `requestCert` + `rejectUnauthorized` against the project CA; map the verified peer cert →
   client identity into the request context; loopback/Tier-0 stays plain (today's behavior).
   Extends the HS-7940 bind plumbing in `server.ts`. **SHIPPED (HS-8993).**

   **What shipped:** `src/auth/tlsListener.ts` — `buildMtlsServeConfig(dataDir, hosts)` loads/creates
   the project CA (#1), signs a server cert, and returns the `@hono/node-server` `serve()` HTTPS
   plumbing (`createServer: https.createServer` + `serverOptions` with `requestCert: true` +
   `rejectUnauthorized: true` + `ca: [caCertPem]`); `collectServerCertHosts(bind, trustedOrigins,
   tlsServerHosts)` chooses the server-cert SANs (concrete bind + plain host/IP trusted origins +
   the new `tlsServerHosts` config; loopback always covered; wildcard binds skipped);
   `peerIdentityFromEnv(env)` reads the verified peer identity off the live TLS socket. `server.ts`
   calls `buildMtlsServeConfig` **only when `exposed`** (else plain HTTP, UNCHANGED), passes the TLS
   config into `tryServe`/`serve()`, sets a new `AppEnv` var **`clientIdentity`** (`ClientIdentity |
   null`) via an early middleware, and on the exposed bind prints "🔒 Mutual TLS REQUIRED",
   switches the URL scheme to `https`, and skips browser auto-open (no client cert locally). The
   terminal-WS + `/ws/sync` upgrades attach to the same (now HTTPS) server unchanged. An exposed bind
   that can't set up the CA (no durable keychain, HS-9019) **fails startup** rather than silently
   serving plaintext. Tests: `src/auth/tlsListener.test.ts` (host selection, peer-identity reads, and
   a real HTTPS server that accepts a CA-signed client + rejects no-cert / foreign-CA clients).
   **Deferred to #4 (HS-8995):** turning `clientIdentity` into authz + removing the secret as the
   primary credential on this tier (today it's surfaced; the HS-7940 secret/origin gate still runs).
3. **`.p12` enrollment** — the desktop flow to mint + export a client `.p12` (CA-signed) for a
   named device, and import an externally-generated one; a local-only CSR-signing endpoint.
   **Server core SHIPPED (HS-8994); client UI + Tauri save split to HS-9024.**

   **What shipped (HS-8994):** the server-side enrollment core. `src/auth/deviceRegistry.ts` —
   per-project enrolled-device registry (`<dataDir>/auth-devices.json`, gitignored): `listDevices` /
   `addDevice` (re-enroll replaces by `clientId`) / `revokeDevice` / `isRevoked({serial|fingerprint})`
   (the seed of #4's connect-time check). `src/auth/ca.ts` gained `readCertMeta` (serial /
   fingerprint / notAfter / identity via native `X509Certificate`). `src/routes/enrollment.ts`
   (mounted `/api`): `POST /api/auth/devices/mint` `{label,password}` → signs a client cert, registers
   it, returns the password-protected `.p12` (base64) + filename; `POST /api/auth/devices/sign-csr`
   `{csrPem,label}` → signs an external CSR with OUR identity; `GET /api/auth/devices`; `POST
   /api/auth/devices/:clientId/revoke`. **Credential creation (mint + sign-csr) is loopback-only**
   (`isLoopbackRequest`) — never invokable by an untrusted remote even with the secret; the first
   device is always enrolled locally (bootstrapping). Typed wire SSOT + callers in
   `src/api/enrollment.ts`. Tests: `src/auth/deviceRegistry.test.ts` + `src/routes/enrollment.test.ts`
   (mint round-trips a `.p12` that re-imports + verifies vs the CA; CSR signs + loopback-gates +
   rejects bad CSRs; list; revoke + 404). **Split to HS-9024:** the Settings "Devices" UI (list / add
   / revoke) + a **Tauri-safe `save_file`** for the `.p12` download (desktop-only surface — Chromium
   e2e can't catch the Tauri `<a download>` no-op, so it needs a real desktop pass). **Blocked by #1.**
4. **Authz + ACLs + revocation** — verified identity → permitted scope (per-project roles, the §88
   model's seed); a per-device **revocation list** checked on connect; remove the bearer-secret as
   the credential on the mTLS listener (keep it Tier-0 only). **SHIPPED (HS-8995)** (WS long-lived
   re-check → HS-9025).

   **What shipped:** `src/auth/authz.ts` — `evaluateClientAuthz({exposed, clientIdentity, device})`
   (pure): Tier-0 → allow (defer to the secret path); Tier-1 → require a verified identity mapping to
   an **enrolled, non-revoked** device, else 403 (`mtls-no-client-cert` / `mtls-unenrolled` /
   `mtls-revoked`). v1 authz = "enrolled + not revoked = full project access" (the §88 roles model's
   seed — the role lookup grows here). `createMtlsAuthzMiddleware({exposed})` is mounted on `/api/*`
   **before** the secret middleware (no-op on Tier-0); on a pass it sets a new `AppEnv` var
   `clientAuthenticated`. **Bearer-secret demoted to defense-in-depth on Tier-1:** `apiAccess.ts`
   /`apiAuthMiddleware.ts` treat a `clientAuthenticated` request as trusted, so a valid client cert
   grants access **without** the shared secret (the cert is the credential); the secret check still
   runs but is no longer the gate. **Revocation** uses sub-ticket 3's registry (`isRevoked` /
   `device.revoked`); per-HTTP-request enforcement means a revoked device gets 403 on every call.
   Tests: `src/auth/authz.test.ts` (decision matrix + middleware vs a real registry) +
   `server.auth.test.ts` (cert-authenticated request trusted without secret/origin). **Deferred to
   HS-9025:** re-checking revocation on already-open long-lived WS connections (per-request covers
   HTTP; an open terminal/`/ws/sync` socket needs a periodic sweep). The Revoke **button** is in the
   HS-9024 device UI. **Blocked by #2.**
5. **QR pairing enrollment** — desktop shows a short-lived pairing QR; a device generates a keypair
   + CSR, signed over the trusted channel. **Server core SHIPPED (HS-8996); QR display SHIPPED
   (HS-9026); device-side page SHIPPED (HS-9033).** Coordinates with the §46 mobile client / HS-7941.
   **Blocked by #3.**

   **What shipped (HS-9033 — the device side):** a standalone, secret-free `/pair` page
   (`src/components/pairPage.tsx` + its own `pair.js` bundle so node-forge stays off the main app).
   `src/client/pair.tsx` reads the payload (in-page `BarcodeDetector` camera scan, or paste/hash
   fallback), and `src/client/pairing/devicePairing.ts` does the in-browser RSA-2048 keypair + PKCS#10
   CSR (private key never leaves the device) and assembles the password-protected `.p12` from the
   device key + the server-signed cert + the CA — all with the SAME node-forge the server signs with,
   so the round-trip is byte-compatible (proven in `devicePairing.test.ts` against `signClientCsr` /
   `readP12`). Two bootstrapping fixes made the end-to-end flow reachable: `pair/complete` is exempt
   from the shared-secret middleware (token is the gate; `apiAuthMiddleware.ts`) and returns
   `caCertPem`. Tests: `pages.test.ts` (route/shell), `devicePairing.test.ts` + `pairingPayload.test.ts`
   (crypto + parse), `e2e/pair.spec.ts` (real paste → in-browser keygen → enroll → `.p12` download).
   **Pairing transits the trusted/tunnel channel** — the exposed mTLS listener rejects an unenrolled
   device at the TLS handshake, so the on-port LAN path is a tracked follow-up. Per-platform cert
   install is manual (docs/manual-test-plan.md §7).

   **What shipped (HS-8996):** `src/auth/pairingTokens.ts` — an in-memory, per-project,
   **single-use, short-TTL (5 min)** pairing-token store (`PairingTokenStore`, clock-injectable;
   `issue(dataDir)` / `consume(token)` → bound data dir once, then gone). `src/routes/enrollment.ts`
   added `POST /api/auth/pair/start` (**loopback-only** — issues a token for the QR) and `POST
   /api/auth/pair/complete` `{token, csrPem, label}` (**token-gated, NOT loopback** — the scanning
   phone is remote; a valid single-use token authorizes `signClientCsr` for the token's project +
   registers the device). Typed callers `startPairing` / `completePairing` (`src/api/enrollment.ts`).
   Tests: `src/auth/pairingTokens.test.ts` (issue/consume/single-use/expiry/per-project, injected
   clock) + `routes/enrollment.test.ts` (start loopback-gate; complete signs+registers from a remote
   caller with a valid token; reused/unknown token → 401; bad CSR → 400). **Split to HS-9026:** the
   desktop **QR display** (encode `{token, url}`, reuse HS-7942's `qrcode`) + the **mobile-web
   client** that scans → generates a CSR → installs the signed cert (coordinates with HS-7941 PWA).
6. **Docs + threat-model sign-off + HS-8987 re-audit** — finalize the threat model, run the
   security-review skill against the new surface. **Blocked by #2 + #4.**

## 94.9 Cross-references

- §46 — service/client decoupling + the original auth/trust model (§46.5).
- §88 (HS-8878) — cloud service, teams + orgs (the authz/ACL consumer).
- §20 — keychain (where the CA + private keys live).
- §97 — the self-hosting mTLS deployment guide (expose / enroll / install / revoke).
- HS-7940 / HS-8983 — the interim bind/origin/otel gates (defense-in-depth under Tier 1).
- HS-8986 — request hardening (sibling, auth-independent).
- HS-8987 — the recurring security-review skill.

## 94.11 Threat-model sign-off (HS-8997, against the SHIPPED implementation)

The §94.3 actors mapped to the concrete mitigation that **shipped** (sub-tickets 1–5) and the
residual risk. "Tier-1" = exposed bind (mTLS engaged); "Tier-0" = localhost (shared secret).

| Actor | Shipped mitigation (Tier-1) | Residual risk |
| --- | --- | --- |
| **On-path network attacker** (LAN / hostile WiFi / compromised router) | In-process **TLS** (`tlsListener.ts`) encrypts + integrity-protects the wire independent of any external tunnel; the TLS 1.3 handshake binds the session. Can't read/modify/replay. | Relies on the client trusting the project CA (cert pinning by CA). A user who clicks through a server-cert mismatch could be MITM'd — mitigated by the client validating against the CA + matching SAN (`collectServerCertHosts`). |
| **Remote internet attacker** (0.0.0.0 / port-forwarded / cloud) | `requestCert: true` + `rejectUnauthorized: true` reject any connection **without a CA-signed client cert at the TLS layer, before any handler** (`buildMtlsServeConfig`). Then per-request authz (`createMtlsAuthzMiddleware`) requires an **enrolled, non-revoked** device. No open path. | An attacker who **steals a client private key** (`.p12` + its password, or the device key) becomes that device until revoked — see bearer-theft row. Brute-forcing a 2048-bit RSA client key is infeasible. |
| **Malicious co-tenant on the tailnet** | Same as remote: no client cert ⇒ no connection; unenrolled cert ⇒ 403. The shared secret is no longer sufficient on Tier-1, so a co-tenant who sniffed/guessed it still can't get in. | Same key-theft caveat. |
| **Bearer-token thief** (reads the shared secret from logs / backup / shoulder-surf / malicious extension) | **The shared secret is no longer the credential on Tier-1** (`apiAccess.ts`/`apiAuthMiddleware.ts` gate on the cert, not the secret). A stolen secret alone grants nothing off-localhost. | The credential is now the **client cert/key**, not a replayable token — strictly better. Theft of the key file is the new equivalent; **per-device revocation** (`deviceRegistry`/`authz`) bounds the blast radius + a cert **expiry** forces rotation. Revocation of an already-open WS is HS-9025 (per-request HTTP is immediate). |
| **Cross-site attacker** (CSRF / CSWSH from a page the user visits) | The HS-7940 origin/CSRF gate **still runs** as defense-in-depth; a browser won't present the client cert to a cross-origin attacker's `fetch` without the user's configured cert + same-origin, and mutations still require trust. | A page can't obtain the client cert, so it can't forge an authenticated Tier-1 request. Standard browser client-cert UX applies. |

**Assets** (ticket data, the shell/terminal RCE-equivalent surface, plugin OAuth + keychain
secrets, telemetry, remote-worker dispatch) are reachable on Tier-1 only after **authn (TLS cert) +
authz (enrolled, non-revoked)**. The CA private key lives in the OS keychain (§20), never on disk in
the clear.

**Net:** the §94.3 "properties we want" — confidentiality+integrity on the wire, mutual auth,
replay/MITM resistance, per-device identity+revocation+expiry, authz-before-execution — are all met
on Tier-1 by the shipped code. Tier-0 (localhost) is deliberately unchanged.

## 94.12 Security re-audit of the mTLS surface (HS-8997)

A focused review of each new surface (the HS-8987 skill's remit), with verdicts. **No
externally-exploitable findings.** Items worth tracking became follow-up tickets.

- **TLS listener (`tlsListener.ts`)** — `requestCert`+`rejectUnauthorized` against the project CA;
  unauthenticated TLS rejected pre-handler. Server cert SANs exclude wildcard binds. ✅ Sound.
- **Cert lifecycle (`ca.ts`)** — RSA-2048, SHA-256, random ≥19-byte serials, `clientAuth`/`serverAuth`
  EKUs, `cA:true`+`keyCertSign` only on the CA. `node-forge@1.3.1` (clean `npm audit`,
  `docs/dependency-security.md`). Native keygen. ✅ Sound.
- **Enrollment (`routes/enrollment.ts`)** — mint + `sign-csr` + `pair/start` are **loopback-only**
  (`isLoopbackRequest`); `pair/complete` is gated by a **single-use, 5-min** token, not loopback (the
  remote phone). The server, not the requester, sets the embedded identity (`signClientCsr` ignores
  the CSR subject). `.p12` is password-protected. ✅ Sound. *Note:* `isLoopbackRequest` trusts the
  socket peer address; behind a reverse proxy that rewrites the peer to loopback, "loopback-only"
  would include proxied remotes — documented in §97 (run mTLS in-process, not behind a TLS-terminating
  proxy, OR ensure the proxy doesn't forward to these routes).
- **Authz + revocation (`authz.ts`)** — every `/api/*` request on Tier-1 maps cert→enrolled,
  non-revoked device or 403; the secret is demoted to defense-in-depth. ✅ Sound. **Residual:** an
  already-open **WebSocket** isn't re-checked on revocation → **HS-9025** (per-request HTTP is
  immediate; WS needs a periodic sweep).
- **Tier split** — mechanical off `isExposedBind`; Tier-0 paths completely unchanged (verified by the
  unchanged `server.auth.test.ts` matrix). An exposed bind with no durable keychain **fails startup**
  rather than serving plaintext (→ **HS-9019** for a keychain-less durable CA). ✅ Sound.
- **Coverage gaps that are follow-ups, not flaws:** client cert install UX (**HS-9024**), QR
  display + mobile client (**HS-9026**), WS revocation sweep (**HS-9025**), keychain-less CA
  (**HS-9019**). None weaken the shipped enforcement; they extend reach/UX.

**Sign-off:** the mTLS enforcement core (sub-tickets 1–5) is sound for the self-hosted exposure
threat model. A fresh end-to-end `security-review` skill pass + a real off-box `--bind` deployment
test (with an installed client cert) should run at the next release per the standing HS-8987 cadence
— the surface is now in `src/auth/**` + `routes/enrollment.ts` + the `server.ts` exposed branch.

## 94.13 Decision: pairing stays tunnel-only — no on-port carve-out (HS-9054, decided 2026-06-26)

**Question.** An unenrolled device (no client cert yet) can't reach `/pair` on the exposed mTLS port:
`tlsListener.ts` sets `requestCert: true` + `rejectUnauthorized: true`, so the TLS handshake is
rejected before any route runs. Should we add an **optional on-port enrollment carve-out** —
`rejectUnauthorized: false` to accept the certless handshake, then app-layer-gate every route except a
deny-by-default allowlist of the pairing surface (`GET /pair`, `/static/pair.js`, `/static/styles.css`,
`POST /api/auth/pair/complete`) — so a LAN device could pair directly without a tunnel?

**Decision: NO. Tunnel-only pairing is the permanent model.** The carve-out was rejected as
not worth the risk. Relaxing `rejectUnauthorized` moves the authentication boundary off the TLS
handshake (where an un-handled case fails *closed* — the server serves nothing) and into the app
layer (where one un-gated route during the pairing window = unauthenticated LAN data access, failing
*open*). The handshake-reject default is the single, fail-closed boundary, and we keep it.

**Consequence / how to pair instead** (documented loudly in docs/97 §97.3):
1. **Pair before exposing** — pair while bound to localhost / trusted LAN, then switch the bind.
2. **Pair over a tunnel** — WireGuard / Tailscale / SSH to the server's local port, then pair through it.

This is now a *stated requirement*, not a gap. HS-9054 is closed as **won't-do (decision: A)** — no
code change; the work was the documentation. (Revisit only if a future need makes certless on-port
enrollment compelling enough to justify the app-layer-gates-everything burden + a fresh threat model.)
