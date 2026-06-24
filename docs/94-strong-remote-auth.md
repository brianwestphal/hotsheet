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
> **Implementation progress:** sub-ticket **1/6 (HS-8992) SHIPPED** — `src/auth/ca.ts` (CA + cert
> lifecycle, pure crypto + keychain I/O, no wire change). Sub-tickets 2–6 pending (see §94.10).

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
   Extends the HS-7940 bind plumbing in `server.ts`. **Blocked by #1.**
3. **`.p12` enrollment** — the desktop flow to mint + export a client `.p12` (CA-signed) for a
   named device, and import an externally-generated one; a local-only CSR-signing endpoint.
   **Blocked by #1.**
4. **Authz + ACLs + revocation** — verified identity → permitted scope (per-project roles, the §88
   model's seed); a per-device **revocation list** checked on connect; remove the bearer-secret as
   the credential on the mTLS listener (keep it Tier-0 only). **Blocked by #2.**
5. **QR pairing enrollment** — desktop shows a short-lived pairing QR; a device generates a keypair
   + CSR, signed over the trusted channel. **Blocked by #3** (+ coordinates with the §46 mobile
   client / HS-7941).
6. **Docs + threat-model sign-off + HS-8987 re-audit** — finalize the threat model, run the
   security-review skill against the new surface. **Blocked by #2 + #4.**

## 94.9 Cross-references

- §46 — service/client decoupling + the original auth/trust model (§46.5).
- §88 (HS-8878) — cloud service, teams + orgs (the authz/ACL consumer).
- §20 — keychain (where the CA + private keys live).
- HS-7940 / HS-8983 — the interim bind/origin/otel gates (defense-in-depth under Tier 1).
- HS-8986 — request hardening (sibling, auth-independent).
- HS-8987 — the recurring security-review skill.
