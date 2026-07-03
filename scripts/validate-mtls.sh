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

# HS-9312 — stage the device identity in the OS keychain under the SAME
# (service, account) the Rust reader uses, so the keychain-path test can read it
# back (the "(b)" flow). macOS `security` only for now; skipped elsewhere. Cleaned
# up on exit. The JSON blob mirrors the enrollment writer's format.
MTLS_SERVICE="com.hotsheet.plugin.mtls"
if [ "$(uname)" = "Darwin" ]; then
  BLOB="$(CERT="$HS_MTLS_CERT_DIR" node -e 'const fs=require("fs"),d=process.env.CERT;process.stdout.write(JSON.stringify({cert:fs.readFileSync(d+"/client.crt","utf8"),key:fs.readFileSync(d+"/client.key","utf8"),ca:fs.readFileSync(d+"/ca.crt","utf8")}))')"
  security add-generic-password -U -s "$MTLS_SERVICE" -a "$HS_MTLS_ORIGIN" -w "$BLOB" >/dev/null 2>&1 || true
  trap 'security delete-generic-password -s "$MTLS_SERVICE" -a "$HS_MTLS_ORIGIN" >/dev/null 2>&1 || true; kill "$HPID" 2>/dev/null || true; rm -f "$OUT"' EXIT
fi

# Run every `#[ignore]`d live handshake test in the proxy module.
cargo test --manifest-path src-tauri/Cargo.toml --lib mtls_proxy::tests -- --ignored --nocapture
