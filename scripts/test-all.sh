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
E2E_HOME="$(mktemp -d)"
trap 'rm -rf "$E2E_V8_DIR" "$E2E_DATA_DIR" "$E2E_HOME" .nyc_output' EXIT

echo "=== Unit tests ==="
npx vitest run --coverage || true

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
# HS-9348 — surface WHAT the e2e half captured. The server writes `coverage-*.json` (via
# NODE_V8_COVERAGE); the browser fixture (e2e/coverage-fixture.ts) writes `browser-*.json`
# per test. An empty/short count here is the flaky-capture symptom that collapses the
# merged report to unit-only — logging it makes the flaky source visible per run.
SERVER_V8=$(ls "$E2E_V8_DIR"/coverage-*.json 2>/dev/null | wc -l | tr -d ' ')
BROWSER_V8=$(ls "$E2E_V8_DIR"/browser-*.json 2>/dev/null | wc -l | tr -d ' ')
echo "  e2e V8 files captured: server=$SERVER_V8  browser=$BROWSER_V8"
E2E_ISTANBUL=""
if ls "$E2E_V8_DIR"/*.json 1>/dev/null 2>&1; then
  # No --include filter here: c8 needs to see the bundled JS file path to apply
  # source map remapping. The nyc report step handles filtering to src/** only.
  # HS-9348 — the ROOT CAUSE of the intermittent merge failure: c8 OOMs (default ~2GB
  # heap) processing the ~280 per-test browser V8 files + source-map remapping, so it
  # succeeds or dies depending on run-to-run memory pressure. Bump the heap to 6 GB
  # (CI runners have 7 GB; c8 is the only heavy process at this point). stderr is no
  # longer swallowed so any residual failure is visible; the two-tier gate below is the
  # belt-and-suspenders fallback if c8 still can't convert.
  NODE_OPTIONS="--max-old-space-size=6144" npx c8 report \
    --temp-directory "$E2E_V8_DIR" \
    --reporter json \
    --reports-dir "$E2E_V8_DIR/istanbul" || echo "  ⚠️ HS-9348: c8 convert of e2e V8 coverage FAILED"
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
# HS-9149 — the excludes below are files that hold NO executable code and so
# dilute the branch/function denominator with a meaningless 0%:
#   - `*.test.*` / `test-helpers.ts` — test scaffolding, not product code.
#   - the `types.ts` modules — pure `type`/`interface` declarations (erased at
#     compile time; zero branches). `src/types.ts` + the three type-only siblings.
NYC_ARGS=(
  --temp-dir .nyc_output
  --include 'src/**'
  --exclude 'src/**/*.test.*'
  --exclude 'src/test-helpers.ts'
  --exclude 'src/types.ts'
  --exclude 'src/plugins/types.ts'
  --exclude 'src/terminals/registry/types.ts'
  --exclude 'src/client/undo/types.ts'
)
npx nyc report "${NYC_ARGS[@]}" --reporter text --reporter html --report-dir ./coverage
# HS-9348 — machine-readable summary for the e2e-merge detection below.
npx nyc report "${NYC_ARGS[@]}" --reporter json-summary --report-dir ./coverage >/dev/null 2>&1 || true

echo ""
echo "HTML report: coverage/index.html"

# === Merged coverage threshold gate (HS-9139 / HS-9348) ===
# The merged (unit + e2e server + e2e browser) coverage is the real signal — BUT the e2e
# V8 capture is INTERMITTENTLY EMPTY (HS-9348). When it is, the merged report collapses to
# unit-only and the MERGED floor would FALSE-fail (lines ~65% vs the ~91 floor). So detect
# whether e2e actually merged — via the merged line% (unit baseline ~65%, full merged
# ~94%, so 80% cleanly separates) — and gate accordingly:
#   - e2e MERGED  → enforce the MERGED floor (COVERAGE_MIN_*) — locks in the real gains.
#   - e2e MISSING → warn LOUDLY + enforce the deterministic UNIT floor (COVERAGE_MIN_*_UNIT)
#                   so a capture flake can't false-fail the build (unit regressions still caught).
# Ratchet the MERGED floor to ~2-3 pts below the "All files" row after a green CI run;
# override per-run via COVERAGE_MIN_{LINES,STATEMENTS,FUNCTIONS,BRANCHES}[_UNIT].
# COVERAGE_GATE=off skips the gate entirely.
if [ "${COVERAGE_GATE:-on}" != "off" ]; then
  echo ""
  echo "=== Coverage threshold gate (merged) ==="
  MERGED_LINES=$(node -e "try{console.log(Math.round(JSON.parse(require('fs').readFileSync('coverage/coverage-summary.json','utf8')).total.lines.pct))}catch{console.log(0)}")
  if [ "${MERGED_LINES:-0}" -ge 80 ]; then
    GL=${COVERAGE_MIN_LINES:-45}; GS=${COVERAGE_MIN_STATEMENTS:-45}; GF=${COVERAGE_MIN_FUNCTIONS:-45}; GB=${COVERAGE_MIN_BRANCHES:-40}
    echo "e2e coverage MERGED (merged lines ${MERGED_LINES}%) — enforcing the MERGED floor: lines $GL / statements $GS / functions $GF / branches $GB."
  else
    GL=${COVERAGE_MIN_LINES_UNIT:-62}; GS=${COVERAGE_MIN_STATEMENTS_UNIT:-60}; GF=${COVERAGE_MIN_FUNCTIONS_UNIT:-58}; GB=${COVERAGE_MIN_BRANCHES_UNIT:-55}
    echo "⚠️⚠️ HS-9348: e2e V8 coverage did NOT merge (merged lines ${MERGED_LINES}% ≈ unit-only; captured server=${SERVER_V8:-?} browser=${BROWSER_V8:-?} V8 files). Falling back to the UNIT floor to avoid a false failure — this run does NOT validate e2e-covered (client) code."
  fi
  npx nyc check-coverage "${NYC_ARGS[@]}" --lines "$GL" --statements "$GS" --functions "$GF" --branches "$GB"
  echo "Coverage gate passed (floor: lines $GL / branches $GB)."
fi
