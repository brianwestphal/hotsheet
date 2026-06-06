#!/usr/bin/env bash
# HS-8790 — compile (+ optionally code-sign) the Apple Foundation Models helper
# used by the Announcer's on-device provider (src-tauri/apple-fm-helper/main.swift).
#
# GUARDED so it can be called from any build without breaking it: it no-ops with
# exit 0 on non-macOS, when swiftc is missing, or when the macOS 26 SDK isn't
# present (FoundationModels). On a capable machine it emits the helper binary at
# $1 (default dist/apple-fm-helper); bundle that with the app and point the
# server at it via HOTSHEET_APPLE_FM_BIN (see docs/tauri-architecture.md).
#
# Code-signing: set CODESIGN_IDENTITY to sign with the app's identity (the helper
# must be signed + notarized with the bundle to run on other machines).
set -euo pipefail

OUT="${1:-dist/apple-fm-helper}"
SRC="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/apple-fm-helper/main.swift"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "[apple-fm] not macOS — skipping helper build"; exit 0
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "[apple-fm] swiftc not found — skipping helper build"; exit 0
fi
if [[ ! -f "$SRC" ]]; then
  echo "[apple-fm] source missing ($SRC) — skipping"; exit 0
fi

mkdir -p "$(dirname "$OUT")"

# Apple Intelligence is arm64-only; needs the macOS 26 SDK for FoundationModels.
if ! swiftc -O -target arm64-apple-macos26 "$SRC" -o "$OUT" 2>/tmp/apple-fm-build.log; then
  echo "[apple-fm] build failed (needs the macOS 26 SDK / Xcode 26) — skipping:"
  sed 's/^/[apple-fm]   /' /tmp/apple-fm-build.log || true
  exit 0
fi

if [[ -n "${CODESIGN_IDENTITY:-}" ]]; then
  codesign --force --options runtime --sign "$CODESIGN_IDENTITY" "$OUT"
  echo "[apple-fm] signed with $CODESIGN_IDENTITY"
fi

echo "[apple-fm] built $OUT"
