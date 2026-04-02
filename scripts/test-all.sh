#!/usr/bin/env bash
# Unified test coverage: merges unit tests + E2E server + E2E browser coverage.
#
# 1. vitest --coverage → Istanbul JSON (coverage/coverage-final.json)
# 2. Build client with source maps (for browser coverage remapping)
# 3. Start server with NODE_V8_COVERAGE, run Playwright with browser coverage, stop server
# 4. c8 converts server V8 data + browser V8 data to Istanbul JSON (source-mapped)
# 5. Merge all Istanbul JSONs, render with nyc
set -e

E2E_V8_DIR="$(mktemp -d)"
E2E_DATA_DIR="$(mktemp -d)"
trap 'rm -rf "$E2E_V8_DIR" "$E2E_DATA_DIR" .nyc_output' EXIT

echo "=== Unit tests ==="
npx vitest run --coverage || true

echo ""
echo "=== Build client for E2E ==="
npm run build:client

echo ""
echo "=== Start server with V8 coverage ==="
NODE_V8_COVERAGE="$E2E_V8_DIR" node --enable-source-maps --import tsx src/cli.ts \
  --data-dir "$E2E_DATA_DIR" --no-open --port 4190 &
SERVER_PID=$!
for i in $(seq 1 30); do
  curl -s http://localhost:4190/ > /dev/null 2>&1 && break
  sleep 0.5
done

echo "=== E2E tests (server + browser coverage) ==="
NO_WEB_SERVER=1 BROWSER_V8_COVERAGE="$E2E_V8_DIR" npx playwright test 2>&1 \
  | grep -E '^\s*(✓|✗|[0-9]+ (passed|failed))' || true

echo ""
echo "=== Stop server ==="
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null || true
sleep 1

echo ""
echo "=== Convert V8 coverage to Istanbul JSON ==="
E2E_ISTANBUL=""
if ls "$E2E_V8_DIR"/*.json 1>/dev/null 2>&1; then
  # No --include filter here: c8 needs to see the bundled JS file path to apply
  # source map remapping. The nyc report step handles filtering to src/** only.
  npx c8 report \
    --temp-directory "$E2E_V8_DIR" \
    --reporter json \
    --reports-dir "$E2E_V8_DIR/istanbul" 2>/dev/null || true
  E2E_ISTANBUL="$E2E_V8_DIR/istanbul/coverage-final.json"
fi

echo ""
echo "=== Merge coverage ==="
node --input-type=module -e "
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';

function merge(a, b) {
  const result = { ...a };
  for (const [file, cov] of Object.entries(b)) {
    if (!result[file]) { result[file] = cov; continue; }
    const t = result[file];
    for (const [k, v] of Object.entries(cov.s || {})) t.s[k] = (t.s[k] || 0) + v;
    for (const [k, v] of Object.entries(cov.b || {})) {
      if (!t.b[k]) t.b[k] = [...v];
      else t.b[k] = t.b[k].map((c, i) => c + (v[i] || 0));
    }
    for (const [k, v] of Object.entries(cov.f || {})) t.f[k] = (t.f[k] || 0) + v;
  }
  return result;
}

let combined = {};
const unitFile = 'coverage/coverage-final.json';
const e2eFile = '${E2E_ISTANBUL}';

if (existsSync(unitFile)) {
  const unit = JSON.parse(readFileSync(unitFile, 'utf-8'));
  combined = merge(combined, unit);
  console.log('  Unit:', Object.keys(unit).length, 'files');
}
if (e2eFile && existsSync(e2eFile)) {
  const e2e = JSON.parse(readFileSync(e2eFile, 'utf-8'));
  combined = merge(combined, e2e);
  console.log('  E2E:', Object.keys(e2e).length, 'files');
}

mkdirSync('.nyc_output', { recursive: true });
writeFileSync('.nyc_output/merged.json', JSON.stringify(combined));
console.log('  Total:', Object.keys(combined).length, 'files');
"

echo ""
echo "=== Coverage report ==="
npx nyc report \
  --temp-dir .nyc_output \
  --reporter text \
  --reporter html \
  --report-dir ./coverage \
  --include 'src/**' \
  --exclude 'src/**/*.test.*' \
  --exclude 'src/test-helpers.ts' \
  --exclude 'src/types.ts'

echo ""
echo "HTML report: coverage/index.html"
