#!/usr/bin/env bash
# Seed data for the upgrade smoke test.
# Usage: bash scripts/seed-upgrade-data.sh [port]
# Run this after starting the stable version of hotsheet.
set -e

PORT="${1:-4195}"
BASE="http://localhost:${PORT}/api"
ORIGIN="-H Origin:http://localhost:${PORT}"

echo "Seeding upgrade test data on port $PORT..."

# Create 3 tickets
T1=$(curl -s -X POST "$BASE/tickets" -H "Content-Type: application/json" $ORIGIN \
  -d '{"title": "Upgrade ticket 1"}')
T1_ID=$(echo "$T1" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).id))")

T2=$(curl -s -X POST "$BASE/tickets" -H "Content-Type: application/json" $ORIGIN \
  -d '{"title": "Upgrade ticket 2"}')
T2_ID=$(echo "$T2" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).id))")

T3=$(curl -s -X POST "$BASE/tickets" -H "Content-Type: application/json" $ORIGIN \
  -d '{"title": "Upgrade ticket 3"}')
T3_ID=$(echo "$T3" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).id))")

# Set statuses
curl -s -X PATCH "$BASE/tickets/$T1_ID" -H "Content-Type: application/json" $ORIGIN \
  -d '{"status": "started"}' > /dev/null

curl -s -X PATCH "$BASE/tickets/$T2_ID" -H "Content-Type: application/json" $ORIGIN \
  -d '{"status": "completed"}' > /dev/null

# T3: set up_next and add a note
curl -s -X PATCH "$BASE/tickets/$T3_ID" -H "Content-Type: application/json" $ORIGIN \
  -d '{"up_next": true}' > /dev/null

curl -s -X PATCH "$BASE/tickets/$T3_ID" -H "Content-Type: application/json" $ORIGIN \
  -d '{"notes": "Pre-upgrade note"}' > /dev/null

echo "Seeded 3 tickets (IDs: $T1_ID, $T2_ID, $T3_ID)"
