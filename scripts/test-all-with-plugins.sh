#!/usr/bin/env bash
# Unified test coverage including plugins: merges unit tests + plugin tests + E2E server + E2E browser coverage.
#
# Same as test-all.sh but adds a separate vitest run for plugins/**/src/*.test.ts
# and merges that coverage into the final report.
set -e

E2E_V8_DIR="$(mktemp -d)"
E2E_DATA_DIR="$(mktemp -d)"
E2E_HOME="$(mktemp -d)"
PLUGIN_COV_DIR="$(mktemp -d)"
trap 'rm -rf "$E2E_V8_DIR" "$E2E_DATA_DIR" "$E2E_HOME" "$PLUGIN_COV_DIR" .nyc_output' EXIT

echo "=== Unit tests (src/) ==="
npx vitest run --coverage || true

echo ""
echo "=== Plugin tests ==="
npx vitest run plugins/*/src/*.test.ts \
  --coverage \
  --coverage.include='plugins/*/src/**/*.ts' \
  --coverage.exclude='plugins/*/src/*.test.ts' \
  --coverage.reportsDirectory="$PLUGIN_COV_DIR" \
  --coverage.reporter=json || true

echo ""
echo "=== Build client for E2E ==="
npm run build:client

echo ""
echo "=== Start server with V8 coverage ==="
# Use isolated HOME so global files (instance.json, projects.json, config.json)
# don't interfere with any running Hot Sheet instance
HOME="$E2E_HOME" NODE_V8_COVERAGE="$E2E_V8_DIR" node --enable-source-maps --import tsx src/cli.ts \
  --data-dir "$E2E_DATA_DIR" --no-open --port 4190 --strict-port &
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
  npx c8 report \
    --temp-directory "$E2E_V8_DIR" \
    --reporter json \
    --reports-dir "$E2E_V8_DIR/istanbul" 2>/dev/null || true
  E2E_ISTANBUL="$E2E_V8_DIR/istanbul/coverage-final.json"
fi

echo ""
echo "=== Merge coverage ==="
PLUGIN_ISTANBUL="$PLUGIN_COV_DIR/coverage-final.json"
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
const sources = [
  ['Unit', 'coverage/coverage-final.json'],
  ['Plugin', '${PLUGIN_ISTANBUL}'],
  ['E2E', '${E2E_ISTANBUL}'],
];
for (const [label, file] of sources) {
  if (file && existsSync(file)) {
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    combined = merge(combined, data);
    console.log('  ' + label + ':', Object.keys(data).length, 'files');
  }
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
  --include 'plugins/*/src/**' \
  --exclude 'src/**/*.test.*' \
  --exclude 'plugins/*/src/*.test.*' \
  --exclude 'src/test-helpers.ts' \
  --exclude 'src/types.ts'

echo ""
echo "HTML report: coverage/index.html"
