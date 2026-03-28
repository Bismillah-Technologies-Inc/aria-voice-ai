#!/usr/bin/env bash
# Smoke-test the EC2 bridge server locally.
#
# Usage:
#   npm run test:local               # uses default http://localhost:3000
#   PORT=8080 npm run test:local     # override port
#
# What it tests:
#   1. GET /health  → { status: "ok" }
#   2. POST /telnyx/call-control with a mock call.initiated event → 200 OK

set -euo pipefail

BASE_URL="http://localhost:${PORT:-3000}"
PASS=0
FAIL=0

ok()   { echo "  [PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

echo ""
echo "Aria EC2 bridge smoke test → $BASE_URL"
echo "──────────────────────────────────────"

# ── 1. Health check ─────────────────────────────────────────────────────────

echo ""
echo "1. GET /health"

HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/health" 2>/dev/null || echo "000")
HEALTH_BODY=$(curl -s "$BASE_URL/health" 2>/dev/null || echo "")

if [ "$HEALTH_STATUS" = "200" ]; then
  ok "HTTP 200"
else
  fail "HTTP $HEALTH_STATUS (is the server running? node ec2/server.mjs)"
fi

if echo "$HEALTH_BODY" | grep -q '"status":"ok"'; then
  ok "Body contains {\"status\":\"ok\"}"
else
  fail "Unexpected body: $HEALTH_BODY"
fi

# ── 2. Mock Telnyx call.initiated webhook ────────────────────────────────────

echo ""
echo "2. POST /telnyx/call-control (mock call.initiated)"

MOCK_PAYLOAD='{
  "data": {
    "event_type": "call.initiated",
    "payload": {
      "call_control_id": "test-cid-smoke-001",
      "direction": "incoming",
      "from": "+10000000000",
      "to": "+19999999999"
    }
  }
}'

WEBHOOK_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$BASE_URL/telnyx/call-control" \
  -H "Content-Type: application/json" \
  -d "$MOCK_PAYLOAD" 2>/dev/null || echo "000")

if [ "$WEBHOOK_STATUS" = "200" ]; then
  ok "HTTP 200 — webhook handler accepted event"
else
  fail "HTTP $WEBHOOK_STATUS (expected 200)"
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "──────────────────────────────────────"
echo "Results: $PASS passed, $FAIL failed"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "Note: make sure the server is running first:"
  echo "  node ec2/server.mjs"
  echo ""
  exit 1
fi
