#!/bin/bash
# deploy-telnyx-assistant.sh — Full Telnyx AI Assistant migration in one script.
#
# Run this from the repo root on any machine with:
#   - AWS CLI configured (aws sts get-caller-identity must succeed)
#   - SAM CLI installed (sam --version must succeed)
#   - Node.js 18+ installed
#   - Internet access to api.telnyx.com and AWS APIs
#
# Usage:
#   ./scripts/deploy-telnyx-assistant.sh [prod|dev]
#
# Prerequisites:
#   1. Fill in all FILL_ME_IN values in .env.prod (or .env.dev)
#   2. AWS credentials configured (aws configure or environment variables)

set -euo pipefail

ENV="${1:-prod}"
REGION="${AWS_REGION:-us-east-1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║   Aria — Telnyx AI Assistant Migration: ${ENV}               ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── Pre-flight checks ─────────────────────────────────────────────────────────

echo "▶ Pre-flight checks..."

if ! aws sts get-caller-identity > /dev/null 2>&1; then
  echo "ERROR: AWS CLI not authenticated. Run 'aws configure' first." >&2
  exit 1
fi

if ! sam --version > /dev/null 2>&1; then
  echo "ERROR: SAM CLI not found. Install from https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html" >&2
  exit 1
fi

if ! node --version > /dev/null 2>&1; then
  echo "ERROR: Node.js not found." >&2
  exit 1
fi

# Load env file
ENV_FILE=".env.${ENV}"
if [ ! -f "${ENV_FILE}" ]; then
  echo "ERROR: ${ENV_FILE} not found. Copy .env.example and fill in values." >&2
  exit 1
fi

set -a; source "${ENV_FILE}"; set +a

# Validate required values are filled in
FILL_CHECK_VARS=(
  TELNYX_API_KEY
  TELNYX_FROM_NUMBER
  TELNYX_TRANSFER_NUMBER
  TELNYX_ASSISTANT_WEBHOOK_SECRET
  DB_HOST
  DB_SECRET_ARN
)

MISSING=()
for VAR in "${FILL_CHECK_VARS[@]}"; do
  VAL="${!VAR:-}"
  if [ -z "$VAL" ] || [ "$VAL" = "FILL_ME_IN" ]; then
    MISSING+=("$VAR")
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  echo "ERROR: The following required values are missing in ${ENV_FILE}:" >&2
  for VAR in "${MISSING[@]}"; do
    echo "  - $VAR" >&2
  done
  exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STACK_NAME="aria-${ENV}"
S3_BUCKET="aria-sam-deploy-${ENV}-${ACCOUNT_ID}"

echo "  ✓ AWS authenticated (account: ${ACCOUNT_ID})"
echo "  ✓ SAM CLI available"
echo "  ✓ All required env vars set"
echo "  ✓ Stack: ${STACK_NAME} | Region: ${REGION}"
echo ""

# ── Step 1: Ensure S3 artifact bucket ────────────────────────────────────────

echo "▶ Step 1/6: Ensuring SAM S3 bucket..."
aws s3 mb "s3://${S3_BUCKET}" --region "${REGION}" 2>/dev/null || true
echo "  ✓ s3://${S3_BUCKET}"
echo ""

# ── Step 2: Populate SSM parameters ──────────────────────────────────────────

echo "▶ Step 2/6: Storing SSM parameters..."
bash "${SCRIPT_DIR}/setup-ssm.sh" "${ENV}"
echo ""

# ── Step 3: SAM build + deploy ────────────────────────────────────────────────

echo "▶ Step 3/6: Building and deploying Lambda stack..."
(cd lambdas && npm install --production --silent)

sam build --template infrastructure/template.yaml --no-cached

sam deploy \
  --stack-name "${STACK_NAME}" \
  --s3-bucket "${S3_BUCKET}" \
  --region "${REGION}" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    "Environment=${ENV}" \
    "DBSecretArn=${DB_SECRET_ARN:-}" \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset

# Extract outputs
ASSISTANT_WEBHOOK_URL=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='AssistantWebhookUrl'].OutputValue" \
  --output text --region "${REGION}")

POST_CALL_URL=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='PostCallHandlerUrl'].OutputValue" \
  --output text --region "${REGION}")

# Write URLs back to env file
node - <<'NODEEOF'
const fs = require('fs');
const envFile = process.env.ENV_FILE;
const webhookUrl = process.env.ASSISTANT_WEBHOOK_URL;
const postCallUrl = process.env.POST_CALL_URL;
let content = fs.readFileSync(envFile, 'utf8');
content = content.replace(/^TELNYX_ASSISTANT_WEBHOOK_BASE_URL=.*$/m, `TELNYX_ASSISTANT_WEBHOOK_BASE_URL=${webhookUrl}`);
content = content.replace(/^POST_CALL_HANDLER_URL=.*$/m, `POST_CALL_HANDLER_URL=${postCallUrl}`);
fs.writeFileSync(envFile, content);
console.log('  ✓ Webhook URL:', webhookUrl);
console.log('  ✓ Post-call URL:', postCallUrl);
NODEEOF

export TELNYX_ASSISTANT_WEBHOOK_BASE_URL="${ASSISTANT_WEBHOOK_URL}"
export POST_CALL_HANDLER_URL="${POST_CALL_URL}"

echo "  ✓ Lambda stack deployed"
echo ""

# ── Step 4: Create / update Telnyx assistant ──────────────────────────────────

echo "▶ Step 4/6: Configuring Telnyx AI Assistant..."
node scripts/setup-telnyx-assistant.mjs "${ENV}"
echo ""

# Reload env to get TELNYX_ASSISTANT_ID written by setup script
set -a; source "${ENV_FILE}"; set +a

# ── Step 5: Assign primary number ─────────────────────────────────────────────

echo "▶ Step 5/6: Assigning ${TELNYX_FROM_NUMBER} to assistant..."
node scripts/assign-telnyx-assistant-number.mjs "${ENV}" primary "${TELNYX_FROM_NUMBER}"
echo ""

# ── Step 6: Verify ────────────────────────────────────────────────────────────

echo "▶ Step 6/6: Verifying cutover..."
node scripts/verify-telnyx-assistant-cutover.mjs "${ENV}" || {
  echo "  ⚠ Verification script returned non-zero. Check logs above."
}
echo ""

echo "╔══════════════════════════════════════════════════════════╗"
echo "║   Migration complete.                                    ║"
echo "║                                                          ║"
echo "║   • Make a test call to ${TELNYX_FROM_NUMBER}     ║"
echo "║   • Watch logs: aws logs tail /aws/lambda/aria-${ENV}-  ║"
echo "║     AssistantWebhooksFunction --follow                  ║"
echo "║                                                          ║"
echo "║   Rollback if needed:                                    ║"
echo "║     npm run assistant:rollback:${ENV}                    ║"
echo "╚══════════════════════════════════════════════════════════╝"
