#!/usr/bin/env bash
# Unified test coverage: merges vitest unit tests + Playwright E2E server coverage.
#
# 1. vitest --coverage → Istanbul JSON (coverage/coverage-final.json)
# 2. Build client assets (pre-step for E2E)
# 3. Start server with NODE_V8_COVERAGE, run Playwright, stop server gracefully
# 4. c8 converts V8 data to Istanbul JSON
# 5. Merge both Istanbul JSONs, render with nyc
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
# Wait for server to be ready
for i in $(seq 1 30); do
  curl -s http://localhost:4190/ > /dev/null 2>&1 && break
  sleep 0.5
done

echo "=== E2E tests ==="
NO_WEB_SERVER=1 npx playwright test 2>&1 | grep -E '^\s*(✓|✗|[0-9]+ (passed|failed))' || true

echo ""
echo "=== Stop server (SIGTERM → clean exit → V8 coverage flush) ==="
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null || true
sleep 1

echo ""
echo "=== Convert E2E V8 coverage to Istanbul JSON ==="
E2E_ISTANBUL=""
if ls "$E2E_V8_DIR"/*.json 1>/dev/null 2>&1; then
  npx c8 report \
    --temp-directory "$E2E_V8_DIR" \
    --reporter json \
    --reports-dir "$E2E_V8_DIR/istanbul" \
    --include 'src/**' \
    --exclude 'src/**/*.test.*' \
    --exclude 'src/test-helpers.ts' \
    --exclude 'src/types.ts' 2>/dev/null || true
  E2E_ISTANBUL="$E2E_V8_DIR/istanbul/coverage-final.json"
fi

echo ""
echo "=== Merging coverage ==="
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
  console.log('  Unit test coverage:', Object.keys(unit).length, 'files');
}
if (e2eFile && existsSync(e2eFile)) {
  const e2e = JSON.parse(readFileSync(e2eFile, 'utf-8'));
  combined = merge(combined, e2e);
  console.log('  E2E server coverage:', Object.keys(e2e).length, 'files');
} else {
  console.log('  No E2E coverage data found');
}

mkdirSync('.nyc_output', { recursive: true });
writeFileSync('.nyc_output/merged.json', JSON.stringify(combined));
console.log('  Merged total:', Object.keys(combined).length, 'files');
"

echo ""
echo "=== Merged coverage report ==="
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
