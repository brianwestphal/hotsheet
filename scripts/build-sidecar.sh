#!/bin/bash
# Build the Tauri sidecar: a Node.js binary + server bundle.
#
# PGLite requires filesystem access to its WASM/data files at runtime,
# which breaks single-binary compilers (pkg, bun compile). Instead, we
# bundle a Node.js binary as the sidecar and include the server code +
# node_modules as Tauri resources.
#
# Usage:
#   bash scripts/build-sidecar.sh                          # builds for current host
#   bash scripts/build-sidecar.sh aarch64-apple-darwin      # builds for specific target
set -e

NODE_VERSION="v20.19.0"
TARGET="${1:-$(rustc --print host-tuple 2>/dev/null || echo "unknown")}"

# Map Rust target triple to Node.js download target
case "$TARGET" in
  aarch64-apple-darwin)       NODE_PLATFORM="darwin-arm64" ;;
  x86_64-apple-darwin)        NODE_PLATFORM="darwin-x64" ;;
  x86_64-pc-windows-msvc)     NODE_PLATFORM="win-x64" ;;
  x86_64-unknown-linux-gnu)   NODE_PLATFORM="linux-x64" ;;
  aarch64-unknown-linux-gnu)  NODE_PLATFORM="linux-arm64" ;;
  *)
    echo "Unsupported target: $TARGET"
    exit 1
    ;;
esac

EXT=""
if [[ "$TARGET" == *"windows"* ]]; then
  EXT=".exe"
fi

SIDECAR="src-tauri/binaries/hotsheet-node-${TARGET}${EXT}"
SERVER_DIR="src-tauri/server"

echo "Building sidecar for $TARGET..."

# --- Step 1: Build the TypeScript server bundle ---
npm run build

# --- Step 2: Download Node.js binary for the target platform ---
mkdir -p src-tauri/binaries

# HS-8867 — `-s` (exists AND non-empty), NOT `-f` (merely exists). The release
# workflows run `npm run test:rust` BEFORE this script, and that step's
# scripts/ensure-sidecar-placeholder.mjs drops a 0-BYTE placeholder at $SIDECAR
# so tauri-build's externalBin existence check passes. With `-f` we'd treat that
# empty placeholder as a real Node binary, skip the download, and bundle a
# 0-byte sidecar — the app then spawns an empty executable that exits instantly
# and never starts the server (hang / white screen at launch). `-s` re-downloads
# over the placeholder; the `mv` below overwrites it.
if [ ! -s "$SIDECAR" ]; then
  echo "Downloading Node.js $NODE_VERSION for $NODE_PLATFORM..."

  if [[ "$TARGET" == *"windows"* ]]; then
    ARCHIVE="node-${NODE_VERSION}-${NODE_PLATFORM}.zip"
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${ARCHIVE}" -o "/tmp/${ARCHIVE}"
    unzip -jo "/tmp/${ARCHIVE}" "node-${NODE_VERSION}-${NODE_PLATFORM}/node.exe" -d src-tauri/binaries/
    mv "src-tauri/binaries/node.exe" "$SIDECAR"
    rm "/tmp/${ARCHIVE}"
  else
    ARCHIVE="node-${NODE_VERSION}-${NODE_PLATFORM}.tar.gz"
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${ARCHIVE}" -o "/tmp/${ARCHIVE}"
    tar -xzf "/tmp/${ARCHIVE}" -C /tmp "node-${NODE_VERSION}-${NODE_PLATFORM}/bin/node"
    mv "/tmp/node-${NODE_VERSION}-${NODE_PLATFORM}/bin/node" "$SIDECAR"
    rm -rf "/tmp/${ARCHIVE}" "/tmp/node-${NODE_VERSION}-${NODE_PLATFORM}"
  fi

  chmod +x "$SIDECAR"
  echo "Node.js binary: $SIDECAR ($(du -h "$SIDECAR" | cut -f1))"
else
  echo "Node.js binary already exists: $SIDECAR"
fi

# --- Step 3: Bundle the server code + production node_modules ---
echo "Bundling server resources..."
rm -rf "$SERVER_DIR"
mkdir -p "$SERVER_DIR"

# Copy the built server bundle, channel server, and client assets
cp dist/cli.js "$SERVER_DIR/"
cp dist/channel.js "$SERVER_DIR/"
mkdir -p "$SERVER_DIR/client"
cp dist/client/app.global.js "$SERVER_DIR/client/"
cp dist/client/styles.css "$SERVER_DIR/client/"
if [ -d dist/client/assets ]; then
  cp -R dist/client/assets "$SERVER_DIR/client/"
fi

# Copy bundled plugins (GitHub Issues, etc.)
if [ -d dist/plugins ]; then
  cp -R dist/plugins "$SERVER_DIR/plugins"
fi

# Copy only the external runtime dependencies (PGLite, Hono, @hono, zod).
#
# node-pty is a native addon (build/Release/pty.node) required by the embedded
# terminal feature. CI installs deps with `npm ci` on the matching target OS,
# so node_modules/node-pty already contains the correct prebuilt binary for
# this target. We copy the whole directory — `cp -R` preserves build/Release/.
#
# HS-8706 — zod is external for channel.js (see tsup.config.ts): bundling it
# crashed channel.js on boot because esbuild initialized @modelcontextprotocol/
# sdk's top-level `z.custom()` schemas before zod's `ZodCustom` class. It must
# ship here so the runtime `import 'zod'` in channel.js resolves. zod is
# dependency-free, so the copy is self-contained. (cli.js still BUNDLES zod, so
# this copy only serves channel.js.)
#
# Optional packages are skipped if they're not yet installed so this script
# stays usable on branches that haven't added the terminal deps yet.
REQUIRED_DEPS=(@electric-sql/pglite hono @hono/node-server zod)
OPTIONAL_DEPS=(node-pty ws @xterm/xterm @xterm/addon-fit @xterm/addon-web-links @xterm/addon-serialize)

for pkg in "${REQUIRED_DEPS[@]}"; do
  dest="$SERVER_DIR/node_modules/$pkg"
  mkdir -p "$(dirname "$dest")"
  cp -R "node_modules/$pkg" "$dest"
done

for pkg in "${OPTIONAL_DEPS[@]}"; do
  if [ -d "node_modules/$pkg" ]; then
    dest="$SERVER_DIR/node_modules/$pkg"
    mkdir -p "$(dirname "$dest")"
    cp -R "node_modules/$pkg" "$dest"
  fi
done

# Verify node-pty's native binary copied correctly (if present).
# node-pty v1.x ships prebuilds/<platform>/pty.node via node-gyp-build.
# Older versions use build/Release/. Check both so the warning stays accurate.
if [ -d "$SERVER_DIR/node_modules/node-pty" ]; then
  if [ -z "$(find "$SERVER_DIR/node_modules/node-pty/prebuilds" "$SERVER_DIR/node_modules/node-pty/build" -name 'pty.node' 2>/dev/null)" ]; then
    echo "WARNING: node-pty copied but no pty.node binary found — terminal will fail to spawn." >&2
  fi
fi

echo "Server resources: $SERVER_DIR/ ($(du -sh "$SERVER_DIR" | cut -f1))"

# HS-8867 — fail LOUD if the sidecar is missing/empty rather than letting a
# broken bundle ship. A 0-byte (or absent) hotsheet-node is the externalBin
# placeholder from ensure-sidecar-placeholder.mjs; bundling it produces an app
# that spawns an empty executable and hangs / white-screens at launch. A real
# Node v20 runtime is tens of MB, so a tiny sanity floor cannot false-positive.
SIDECAR_BYTES=$(wc -c < "$SIDECAR" 2>/dev/null | tr -d '[:space:]')
if [ -z "$SIDECAR_BYTES" ] || [ "$SIDECAR_BYTES" -lt 1000000 ]; then
  echo "ERROR: sidecar $SIDECAR is missing or too small (${SIDECAR_BYTES:-0} bytes) — refusing to bundle a non-functional Node runtime." >&2
  exit 1
fi
if [ "$EXT" = "" ] && [ ! -x "$SIDECAR" ]; then
  echo "ERROR: sidecar $SIDECAR is not executable." >&2
  exit 1
fi
echo "Sidecar binary OK: $SIDECAR ($SIDECAR_BYTES bytes)"
echo "Done."
