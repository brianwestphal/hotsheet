# 97. Self-hosting Hot Sheet over mutual TLS (deployment guide)

HS-8997. How to expose Hot Sheet off your machine **safely**, using the mutual-TLS (mTLS) auth
shipped in HS-8985 (design + threat model: [`94-strong-remote-auth.md`](94-strong-remote-auth.md)).

**TL;DR.** On localhost you need nothing new — Hot Sheet stays plain HTTP + the per-project shared
secret. The moment you bind off-localhost (`--bind`), Hot Sheet becomes an **HTTPS server that
requires a client certificate**: you mint one per device, install it, and connect over `https://`.
A device with no (or a revoked) certificate can't reach anything.

## 97.1 The two tiers

| | **Tier 0 — localhost (default)** | **Tier 1 — exposed (`--bind` off-loopback)** |
| --- | --- | --- |
| Transport | plain HTTP | **HTTPS (in-process TLS)** |
| Credential | per-project shared secret | **per-device client certificate (mTLS)** |
| Setup | none | mint + install a client cert per device |

The switch is mechanical: a loopback bind (`127.0.0.1`, the default) is Tier 0; any other bind is
Tier 1. You do **not** opt into mTLS separately — exposing the server turns it on, and an exposed
server that can't set up its certificate authority **refuses to start** (it will not silently serve
plaintext).

## 97.2 Expose the server

```bash
hotsheet --bind 0.0.0.0          # all interfaces
# or a specific interface IP:
hotsheet --bind 192.168.1.50
```

(or set `bind` in `~/.hotsheet/config.json`). On startup you'll see:

```
  ⚠ Bound to 0.0.0.0 — reachable off this machine.
  🔒 Mutual TLS REQUIRED — connect over https:// with an enrolled client certificate.
  ...
  Hot Sheet running at https://localhost:4174
```

On first exposed launch Hot Sheet generates a **per-project Certificate Authority** (CA) and stores
its private key in your OS keychain (macOS Keychain / Linux libsecret). The CA signs the server's
own cert and every device cert you mint.

**Server-cert hostnames.** The cert covers `localhost` + the bind address automatically. If you bind
to a wildcard (`0.0.0.0`) and connect via a hostname or external IP, add those to
`config.json:tlsServerHosts` (a string array) so the cert's SANs match what clients dial — otherwise
clients will see a hostname-mismatch error.

**Keychain-less hosts (Windows / headless Linux).** A headless server often has no usable OS keychain
(no `secret-tool` daemon; Windows isn't wired up). There, set an environment variable
**`HOTSHEET_CA_PASSPHRASE`** before starting an exposed server (HS-9019):

```bash
export HOTSHEET_CA_PASSPHRASE='a-long-random-passphrase'
hotsheet --bind 0.0.0.0
```

The CA private key is then encrypted at rest (AES-256-GCM, key derived from the passphrase via
scrypt) in `<dataDir>/auth-ca.enc` instead of the keychain. **Keep the passphrase safe and stable** —
it's required on every restart, and losing it means re-enrolling every device (a new CA is generated).
If neither a keychain nor `HOTSHEET_CA_PASSPHRASE` is available, an exposed bind **refuses to start**
(it will never fall back to a plaintext or an ephemeral CA). On macOS/Linux with a working keyring you
don't need the passphrase — the keychain is used automatically.

## 97.3 Enroll a device (mint + install a client `.p12`)

Each device that should connect gets its own certificate. **Minting is loopback-only** — you run it
on the server machine (the first device is always enrolled locally; bootstrapping).

**From the UI (HS-9024).** Open **Settings → Remote Access**. Click **Add Device…**, give it a name
and an export password, and Hot Sheet downloads a password-protected `.p12` (a native Save dialog in
the desktop app; a normal browser download otherwise). The device then lists with its enrollment +
expiry, and a **Revoke** button.

**From the API** (equivalent; handy for headless hosts):

```bash
# On the server machine (loopback):
curl -sk https://localhost:4174/api/auth/devices/mint \
  -H 'Content-Type: application/json' \
  -d '{"label":"Brian iPhone","password":"choose-a-strong-p12-password"}' \
  | jq -r .p12Base64 | base64 -d > brian-iphone.p12
```

Either way, transfer the `.p12` to the device over a trusted channel and **install it** (it's
password-protected):

- **macOS:** double-click → add to Keychain (login). Safari/Chrome will offer it on connect.
- **iOS:** AirDrop/email the `.p12` → Settings → Profile Downloaded → install; then enable it for the
  site.
- **Windows:** double-click → Certificate Import Wizard (Personal store).
- **Firefox:** Settings → Privacy & Security → Certificates → Your Certificates → Import.

Then browse to `https://<server-host>:4174` and pick the certificate when prompted.

**QR pairing (HS-9026).** Instead of copying a `.p12`, click **Pair a Device…** in Settings → Remote
Access. Confirm the address the device will reach the server at, and Hot Sheet shows a single-use,
expiring **QR code**. The device scans it, generates its own key + CSR in the browser, and enrolls
over the pairing token — no `.p12` to move. (The desktop QR display is shipped; the mobile client
that scans → generates the CSR → installs the signed cert is platform-specific and tracked as a
manual flow — see the manual test plan.)

## 97.4 Revoke a device

**From the UI:** Settings → Remote Access → the device's **Revoke** button (confirm in the dialog).

**From the API:**

```bash
curl -sk https://localhost:4174/api/auth/devices/<clientId>/revoke -X POST   # (with a valid client cert)
# list devices to find the clientId:
curl -sk https://localhost:4174/api/auth/devices
```

Revoking is immediate for new requests (a revoked device gets 403 on every API call). An already-open
terminal/sync WebSocket from a just-revoked device is closed on the next periodic re-check sweep
(~30 s; HS-9025) — HTTP is immediate. Certificates also carry an **expiry** (re-mint to rotate).

## 97.5 Deployment notes + caveats

- **Run mTLS in-process — not behind a TLS-terminating reverse proxy** for these routes. Hot Sheet's
  "loopback-only" enrollment guard trusts the socket peer address; a proxy that terminates TLS and
  forwards to Hot Sheet over loopback would make every proxied request look local. If you must front
  it with a proxy, do **not** forward `/api/auth/*` through it, or use the in-process listener for the
  exposed surface (the recommended path).
- **A tunnel is still welcome.** WireGuard/Tailscale gives network-layer encryption + peer auth; mTLS
  layers on top (defense-in-depth). But the tunnel no longer *substitutes* for auth once exposed —
  mTLS is the credential.
- **The shared secret still exists** as defense-in-depth on Tier 1, but it is not the gate there — a
  valid client cert is. On Tier 0 the secret remains the credential, unchanged.
- **Hosted/multi-tenant cloud** is out of scope here (§94.6 / §88) — that will add its own
  OIDC/SSO; this guide is for **self-hosted** exposure.

## 97.6 Cross-references

- [`94-strong-remote-auth.md`](94-strong-remote-auth.md) — the architecture, decisions, threat model
  (§94.11) + security re-audit (§94.12).
- [`46-service-client-decoupling.md`](46-service-client-decoupling.md) §46.5 — the trust model.
- [`dependency-security.md`](dependency-security.md) — the `node-forge` posture.
- Shipped follow-ups: HS-9019 (keychain-less CA via `HOTSHEET_CA_PASSPHRASE`), HS-9024 (Settings →
  Remote Access device UI + Tauri `save_file`), HS-9025 (WS revocation re-check sweep), HS-9026 (QR
  pairing desktop display). Remaining manual/platform work: the mobile client that scans the QR,
  generates its CSR, and installs the signed cert (see the manual test plan).
