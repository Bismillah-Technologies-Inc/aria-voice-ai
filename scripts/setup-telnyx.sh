#!/usr/bin/env bash
# setup-telnyx.sh — Create Telnyx Call Control Application and assign phone number
# Usage: bash scripts/setup-telnyx.sh [dev|prod]
set -euo pipefail

ENV=${1:-dev}
ENV_FILE=".env.${ENV}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Error: ${ENV_FILE} not found"
  exit 1
fi

# shellcheck disable=SC1090
source "${ENV_FILE}"

WEBHOOK_URL="https://stream.bismillahtech.ai/telnyx/call-control"
APP_NAME="aria-${ENV}"

echo "=== Telnyx Setup (${ENV}) ==="
echo "Webhook URL : ${WEBHOOK_URL}"
echo "Phone number: ${TELNYX_FROM_NUMBER}"
echo ""

# ── 1. Create Call Control Application ────────────────────────────────────────
echo "--- Creating Call Control Application '${APP_NAME}' ---"
APP_RESPONSE=$(curl -sf -X POST https://api.telnyx.com/v2/call_control_applications \
  -H "Authorization: Bearer ${TELNYX_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"application_name\":    \"${APP_NAME}\",
    \"webhook_event_url\":   \"${WEBHOOK_URL}\",
    \"webhook_api_version\": \"2\"
  }")

APP_ID=$(echo "${APP_RESPONSE}" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
echo "Created: ${APP_NAME} (id: ${APP_ID})"

# ── 2. Assign phone number to application ─────────────────────────────────────
echo ""
echo "--- Assigning ${TELNYX_FROM_NUMBER} to application ---"
curl -sf -X POST https://api.telnyx.com/v2/phone_numbers/jobs/update_phone_numbers \
  -H "Authorization: Bearer ${TELNYX_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"phone_numbers\": [\"${TELNYX_FROM_NUMBER}\"], \"connection_id\": \"${APP_ID}\"}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('Job status:', d.get('data',{}).get('status','submitted'))"

echo ""
echo "=== Done ==="
echo "Add to ${ENV_FILE}:"
echo "  TELNYX_APP_ID=${APP_ID}"
