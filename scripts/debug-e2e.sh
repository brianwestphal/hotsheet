#!/usr/bin/env bash
# Debug E2E test failures by starting a server and running basic API checks.
# Usage: bash scripts/debug-e2e.sh [spec-file]
set -e

SPEC="${1:-e2e/tickets.spec.ts}"
TMPDIR=$(mktemp -d)
LOG="/tmp/e2e-server-debug.log"

# Kill any existing server on 4190
lsof -ti:4190 | xargs kill 2>/dev/null || true
sleep 1

echo "=== Building client ==="
npm run build:client 2>/dev/null

echo "=== Starting server (data-dir: $TMPDIR) ==="
npx tsx src/cli.ts --data-dir "$TMPDIR" --no-open --port 4190 > "$LOG" 2>&1 &
PID=$!
sleep 4

echo "=== Server PID: $PID ==="
echo "=== Basic health check ==="
echo "  Page loads: $(curl -s http://localhost:4190/ | grep -c 'draft-input') matches for draft-input"
echo "  API /tickets: $(curl -s http://localhost:4190/api/tickets)"
echo "  API /stats: $(curl -s http://localhost:4190/api/stats)"

echo ""
echo "=== Creating a test ticket via API ==="
curl -s -X POST http://localhost:4190/api/tickets \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:4190" \
  -d '{"title": "Debug test ticket"}'
echo ""

echo ""
echo "=== Running E2E spec: $SPEC ==="
NO_WEB_SERVER=1 npx playwright test "$SPEC" --reporter=line 2>&1 || true

echo ""
echo "=== Server still alive? ==="
curl -s http://localhost:4190/api/stats 2>/dev/null && echo " (yes)" || echo " (no — server died)"

echo ""
echo "=== Server log ==="
cat "$LOG"

echo ""
echo "=== Cleanup ==="
kill $PID 2>/dev/null || true
wait $PID 2>/dev/null || true
rm -rf "$TMPDIR"
echo "Done."
