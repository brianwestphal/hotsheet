#!/usr/bin/env bash
# HS-9309 Phase-A — orchestrate the mTLS handshake validation. Starts the Node
# mTLS harness (scripts/validate-mtls.mts), then runs the `#[ignore]`d live Rust
# tests (src-tauri/src/mtls_proxy.rs) against it with HS_MTLS_PORT/HS_MTLS_CERT_DIR
# set, then tears the harness down. Proves the desktop loopback proxy's
# reqwest/rustls (+ tokio-tungstenite) client completes a real client-auth
# handshake against the shipped Node mTLS listener + real .p12→PEM material.
#
# Run: npm run validate:mtls
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="$(mktemp)"
npx tsx scripts/validate-mtls.mts >"$OUT" 2>&1 &
HPID=$!
trap 'kill "$HPID" 2>/dev/null || true; rm -f "$OUT"' EXIT

for _ in $(seq 1 100); do
  grep -q READY "$OUT" 2>/dev/null && break
  sleep 0.2
done
if ! grep -q READY "$OUT"; then
  echo "harness failed to start:" >&2; cat "$OUT" >&2; exit 1
fi

READY="$(grep READY "$OUT" | head -1)"
export HS_MTLS_PORT="$(echo "$READY" | awk '{print $2}')"
export HS_MTLS_CERT_DIR="$(echo "$READY" | awk '{print $3}')"
export HS_MTLS_ORIGIN="https://127.0.0.1:$HS_MTLS_PORT"
echo "mTLS harness up on 127.0.0.1:$HS_MTLS_PORT (certs: $HS_MTLS_CERT_DIR)"

# HS-9314 — stage the device identity via the REAL Node writer (writeMtlsIdentity),
# so this validates the Node-write ↔ Rust-read keychain contract end-to-end (not a
# hand-rolled `security` command). `keychainSet` handles macOS + Linux; on a
# platform/env without a keychain the write no-ops and the keychain test SKIPS.
# Cleaned up on exit via the matching Node deleter.
npx tsx scripts/mtls-stage-identity.mts write "$HS_MTLS_ORIGIN" "$HS_MTLS_CERT_DIR" || echo "identity staging failed; keychain test will skip"
trap 'npx tsx scripts/mtls-stage-identity.mts delete "$HS_MTLS_ORIGIN" >/dev/null 2>&1 || true; kill "$HPID" 2>/dev/null || true; rm -f "$OUT"' EXIT

# Run every `#[ignore]`d live handshake test in the proxy module.
cargo test --manifest-path src-tauri/Cargo.toml --lib mtls_proxy::tests -- --ignored --nocapture
