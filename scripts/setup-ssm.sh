#!/bin/bash
# setup-ssm.sh — Populate SSM Parameter Store for one environment.
# Usage: ./scripts/setup-ssm.sh <dev|prod>
#
# Sources values from .env.<env> if it exists, otherwise prompts interactively.
# All parameters stored under /aria/<env>/<NAME> as SecureString or String.

set -euo pipefail

ENV="${1:?Usage: ./scripts/setup-ssm.sh <dev|prod>}"
REGION="${AWS_REGION:-us-east-1}"
PREFIX="/aria/${ENV}"

if [[ "${ENV}" != "dev" && "${ENV}" != "prod" ]]; then
  echo "ERROR: Environment must be 'dev' or 'prod'" >&2
  exit 1
fi

echo "=== Aria SSM Setup: ${ENV} ==="
echo "Region:    ${REGION}"
echo "Prefix:    ${PREFIX}"
echo ""

# Load .env.<env> if it exists
ENV_FILE=".env.${ENV}"
if [ -f "${ENV_FILE}" ]; then
  echo "Loading values from ${ENV_FILE}..."
  # shellcheck disable=SC1090
  set -a; source "${ENV_FILE}"; set +a
fi

# Helper: store a parameter, prompting if value is empty
store_param() {
  local name=$1
  local value="${2:-}"
  local type="${3:-String}"

  if [ -z "${value}" ]; then
    read -rp "  ${PREFIX}/${name}: " value
    if [ -z "${value}" ]; then
      echo "  SKIPPED (empty)"
      return
    fi
  fi

  aws ssm put-parameter \
    --name "${PREFIX}/${name}" \
    --value "${value}" \
    --type "${type}" \
    --overwrite \
    --region "${REGION}" \
    --no-cli-pager \
    > /dev/null

  echo "  ✓ ${PREFIX}/${name}"
}

echo "--- Deepgram ---"
# Optional — only needed if EC2 bridge is re-enabled
store_param "DEEPGRAM_API_KEY" "${DEEPGRAM_API_KEY:-not-configured}"

echo "--- Bedrock ---"
store_param "BEDROCK_MODEL_ID"  "${BEDROCK_MODEL_ID:-us.anthropic.claude-sonnet-4-5-20250929-v1:0}"
store_param "BEDROCK_REGION"    "${BEDROCK_REGION:-us-east-1}"

echo "--- Database ---"
store_param "DB_HOST" "${DB_HOST:-}"
store_param "DB_PORT" "${DB_PORT:-5432}"
store_param "DB_NAME" "${DB_NAME:-aria_${ENV}}"
store_param "DB_USER" "${DB_USER:-}"
# DB_PASSWORD is intentionally omitted — password is fetched at runtime
# from AWS Secrets Manager via the DB_SECRET_ARN CloudFormation parameter.

echo "--- Google Calendar ---"
# These are optional — stored as empty string if not configured so CloudFormation
# SSM dynamic references resolve without error. Calendar tools fail gracefully at runtime.
store_param "GOOGLE_SERVICE_ACCOUNT_EMAIL" "${GOOGLE_SERVICE_ACCOUNT_EMAIL:-not-configured}"
store_param "GOOGLE_CALENDAR_PRIVATE_KEY"  "${GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY:-not-configured}" "SecureString"
store_param "GOOGLE_CALENDAR_ID"           "${GOOGLE_CALENDAR_ID:-primary}"

echo "--- Telnyx ---"
store_param "TELNYX_API_KEY"         "${TELNYX_API_KEY:-}"
store_param "TELNYX_FROM_NUMBER"     "${TELNYX_FROM_NUMBER:-}"
store_param "TELNYX_TRANSFER_NUMBER" "${TELNYX_TRANSFER_NUMBER:-}"
store_param "TELNYX_ASSISTANT_WEBHOOK_SECRET" "${TELNYX_ASSISTANT_WEBHOOK_SECRET:-}" "SecureString"

echo "--- Other ---"
store_param "BOOKING_LINK" "${BOOKING_LINK:-https://cal.com/aria-demo}"
store_param "MIRZA_PHONE"  "${MIRZA_PHONE:-}"

echo ""
echo "=== SSM parameters stored under ${PREFIX}/ ==="
