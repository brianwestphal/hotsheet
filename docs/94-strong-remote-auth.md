# 94. Strong Remote Authentication (mTLS + per-client identity)

HS-8985. A security-architecture design for authenticating remote access to the Hot Sheet
service with real cryptographic mutual auth, replacing/augmenting today's single per-project
shared secret. Motivated by the user's directive on HS-8983: the remote surface "is very likely
to be a popular attack surface... we ideally need something like HTTPS mutual auth and strong
challenge-based public-private-key authentication... every request authenticated and validated
before execution."

> **Status:** Design only — **awaiting the user's steer on the key forks (§94.8)** before any
> implementation. Rolling crypto/auth blind is a serious risk; this doc lays out the threat model,
> the candidate architecture, and the decisions that need a human call.

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

### 94.4.2 Enrollment (how a device gets its client cert)

The hard UX problem. Options (a §94.8 decision):
- **Pairing over the existing trusted channel** — the user is already authenticated locally (or
  over the tunnel). The device generates a key pair, sends a CSR, the server (on an
  already-trusted/local request) signs it and returns the cert. Bootstrapped by a short-lived
  pairing code / QR shown in the desktop app (mirrors the §46/HS-7942 "Open on iPhone" QR), scanned
  over the tunnel.
- **Out-of-band cert install** — power users import a `.p12` they generated. Simple, no pairing
  flow, but clunky.

### 94.4.3 Transport: in-process TLS vs reverse-proxy (a §94.8 decision)

- **(A) In-process TLS** — Node `https`/`tls` server with `requestCert`. Hot Sheet owns the certs +
  CA + mTLS. Self-contained, no extra deps, works for the Tauri sidecar + headless. More code in
  our security-critical path; cert lifecycle is ours.
- **(B) Reverse-proxy contract** — document that mTLS is terminated by Caddy/nginx, which passes
  the verified client identity in a trusted header (e.g. `X-Client-Cert-CN`) over loopback; Hot
  Sheet trusts that header ONLY from loopback. Less crypto code in Hot Sheet; offloads TLS to
  battle-tested infra; but pushes setup burden onto the user + adds a trust-the-header surface.

## 94.5 Tiers (don't force mTLS on the hobbyist)

A single user on a private tailnet should not need a CA + per-device certs. Propose **two tiers**,
selected by deployment:
- **Tier 0 — loopback / tunnel (today).** Loopback bind, or WireGuard/Tailscale tunnel
  (network-layer encryption + peer auth) + the per-project shared secret. Unchanged; the default.
- **Tier 1 — exposed / multi-user (new, this epic).** mTLS + per-device certs + ACLs. Required
  whenever the server is bound to a non-tunnel, non-loopback interface for untrusted reach, and for
  the §88 cloud/teams model.

This keeps the simple case simple while giving the strong story where it matters. (A §94.8
decision: is Tier 1 opt-in, or forced whenever `--bind` is non-loopback-non-tunnel?)

## 94.6 Relationship to existing tickets

- **HS-7940** (bind + origin gate) / **HS-8983** (otel gate) — the interim hardening; the
  GET-lockdown + origin checks remain as defense-in-depth under Tier 1.
- **HS-7946** (per-client identity / clientId registry) — subsumed: the client cert IS the
  cryptographic per-client identity. The clientId registry becomes the enrolled-device registry.
- **HS-8986** (request hardening — size caps, rate limits, schema bounds) — sibling; independent of
  the auth model and should land regardless (defense-in-depth even under mTLS).
- **HS-8987** (security-review skill) — the standing mechanism that re-audits this surface each
  release.
- **HS-8878 / §88** (cloud service, teams + orgs) — the ACL/authz layer this enables; the cloud
  model likely layers OIDC/SSO for human login on top of (or instead of) per-device mTLS for the
  hosted product. **A fork:** self-hosted exposure (mTLS) vs the hosted cloud (probably OIDC + a
  session model) may want different auth — see §94.8.

## 94.7 Phasing (once the model is chosen)

1. **CA + cert lifecycle** — generate/store the per-project CA + server cert (keychain); a
   `src/auth/ca.ts`. No wire change yet.
2. **In-process mTLS listener** (or the reverse-proxy header contract) — `requestCert`, peer-cert →
   identity, behind a flag; loopback/Tier-0 unchanged.
3. **Enrollment flow** — CSR signing endpoint (local/paired only) + the desktop pairing-code/QR UX.
4. **Authz + ACLs** — map identity → permitted scope; remove the bearer-secret path on the mTLS
   listener; revocation list.
5. **Docs + threat-model sign-off** + the HS-8987 skill re-audit.

## 94.8 Decisions needed from the user (FEEDBACK NEEDED)

Before implementing, the key forks (the answers shape everything downstream):

1. **mTLS confirmed as the mechanism?** I recommend YES, with mTLS's own handshake serving as the
   "challenge-response" (do NOT hand-roll a custom challenge protocol on top — it's the dangerous
   part). Confirm, or do you specifically want a separate application-layer challenge too?
2. **Transport: (A) in-process Node TLS** that Hot Sheet owns end-to-end, **or (B) a documented
   reverse-proxy** (Caddy/nginx) terminating mTLS + passing identity over loopback? (A = turnkey,
   more of our code in the security path; B = less crypto code, more user setup.)
3. **Tiers:** keep the Tier-0 loopback/tunnel + shared-secret path as the default for single-user,
   with mTLS as the Tier-1 exposure story? Or move everything to mTLS?
4. **Scope target:** is this primarily for **self-hosted exposure** (where mTLS fits), the **§88
   hosted cloud** (where OIDC/SSO + sessions may fit better), or **both** (two auth modes)?
5. **Enrollment UX:** the paired-CSR + QR flow, or out-of-band `.p12` import, or both?

## 94.9 Cross-references

- §46 — service/client decoupling + the original auth/trust model (§46.5).
- §88 (HS-8878) — cloud service, teams + orgs (the authz/ACL consumer).
- §20 — keychain (where the CA + private keys live).
- HS-7940 / HS-8983 — the interim bind/origin/otel gates (defense-in-depth under Tier 1).
- HS-8986 — request hardening (sibling, auth-independent).
- HS-8987 — the recurring security-review skill.
