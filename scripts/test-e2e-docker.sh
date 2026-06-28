#!/usr/bin/env bash
# Run the Playwright e2e suite inside the same Linux container CI uses, so
# local sweeps reproduce CI failures faithfully. The CI runner is
# `ubuntu-latest` (currently Noble) with Chromium installed via `npx
# playwright install`; the `mcr.microsoft.com/playwright:vX.Y.Z-noble`
# image matches that exactly (Microsoft ships one image per Playwright
# version, pinned to the same browser binaries the npm install would
# fetch).
#
# Usage:
#   bash scripts/test-e2e-docker.sh                   # full e2e suite
#   bash scripts/test-e2e-docker.sh e2e/lifecycle.spec.ts  # one spec
#   bash scripts/test-e2e-docker.sh -g "Shift+click"  # by grep
#
# Requires Docker Desktop running. Mounts the repo read-write so test
# artefacts (test-results/) land back in your working tree.

set -euo pipefail

cd "$(dirname "$0")/.."

# Resolve the Playwright version we're locked to (so the image always
# matches the package — no drift between local and CI).
PW_VERSION=$(node -p "require('./package.json').devDependencies['@playwright/test'].replace(/^\^|~/, '')")
IMAGE="mcr.microsoft.com/playwright:v${PW_VERSION}-noble"

echo ">>> Using image: ${IMAGE}"
echo ">>> CWD:         $(pwd)"
echo

# Pull lazily (no-op if already cached). Stream so the user sees progress
# on the first run.
docker pull "${IMAGE}"

# `--ipc=host` per Playwright docs — Chromium needs more shared memory
# than the default 64 MB or pages crash.
# `-w /work` so node sees the repo at the same path as in CI.
# `--init` so signals (Ctrl-C) terminate cleanly.
# `-e HOME=/tmp` so `npm`/`tsx` write their caches to a writable dir.
# `-e CI=true` so npm + playwright pick CI defaults (no progress bars,
#   silent install, etc.).
# `-v /work/node_modules` (HS-9154) — CRITICAL: an anonymous volume that SHADOWS
#   node_modules so the container's `npm ci` writes Linux binaries into a
#   throwaway volume, NOT your host (macOS) tree. Without this, `npm ci` rebuilds
#   node_modules IN THE MOUNT and overwrites the host's native binaries
#   (node-pty `pty.node`, `@esbuild/<platform>`), which then can't load on macOS
#   and breaks launching Hot Sheet until you reinstall. dist/coverage/test-results
#   stay on the bind mount so artifacts still come back.
docker run --rm -it \
  --ipc=host \
  --init \
  -v "$(pwd):/work" \
  -v /work/node_modules \
  -w /work \
  -e HOME=/tmp \
  -e CI=true \
  "${IMAGE}" \
  bash -lc "npm ci --no-audit --no-fund --prefer-offline && npm run build:client && npx playwright test --project=chromium $* --reporter=line"
