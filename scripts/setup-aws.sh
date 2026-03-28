#!/bin/bash
# setup-aws.sh — One-time infrastructure bootstrap for one environment.
# Usage: ./scripts/setup-aws.sh <dev|prod>
#
# Steps:
#   1. Create S3 bucket for SAM artifacts
#   2. Populate SSM parameters
#   3. Build and deploy SAM stack
#   4. Create first Cognito admin user
#   5. Print outputs needed for the dashboard and assistant rollout

set -euo pipefail

ENV="${1:?Usage: ./scripts/setup-aws.sh <dev|prod>}"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --no-cli-pager)
STACK_NAME="aria-${ENV}"
S3_BUCKET="aria-sam-deploy-${ENV}-${ACCOUNT_ID}"

if [[ "${ENV}" != "dev" && "${ENV}" != "prod" ]]; then
  echo "ERROR: Environment must be 'dev' or 'prod'" >&2
  exit 1
fi

echo "================================================"
echo "  Aria Voice Agent — ${ENV} Environment Setup"
echo "================================================"
echo "Region:    ${REGION}"
echo "Account:   ${ACCOUNT_ID}"
echo "Stack:     ${STACK_NAME}"
echo "S3 Bucket: ${S3_BUCKET}"
echo ""

# ── Step 1: SAM artifact bucket ───────────────────────────────────────────────
echo "Step 1/4: Creating SAM artifact bucket..."
if aws s3 ls "s3://${S3_BUCKET}" --region "${REGION}" > /dev/null 2>&1; then
  echo "  Bucket already exists."
else
  aws s3 mb "s3://${S3_BUCKET}" --region "${REGION}" --no-cli-pager
  echo "  ✓ Created s3://${S3_BUCKET}"
fi

# ── Step 2: SSM parameters ────────────────────────────────────────────────────
echo ""
echo "Step 2/4: Storing SSM parameters..."
bash "$(dirname "$0")/setup-ssm.sh" "${ENV}"

# ── Step 3: SAM build + deploy ────────────────────────────────────────────────
echo ""
echo "Step 3/4: Building and deploying SAM stack..."

# Install Lambda dependencies once at the shared lambdas package root.
echo "  Installing Lambda dependencies..."
(cd lambdas && npm install --production --silent)

sam build \
  --template infrastructure/template.yaml \
  --no-cached

sam deploy \
  --stack-name "${STACK_NAME}" \
  --s3-bucket "${S3_BUCKET}" \
  --region "${REGION}" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    "Environment=${ENV}" \
    "AllowedOrigin=*" \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset

echo "  ✓ SAM stack deployed"

# ── Step 4: Get outputs ───────────────────────────────────────────────────────
echo ""
echo "Step 4/4: Reading stack outputs..."

get_output() {
  aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --query "Stacks[0].Outputs[?OutputKey=='${1}'].OutputValue" \
    --output text \
    --region "${REGION}" \
    --no-cli-pager
}

API_URL=$(get_output "DashboardApiUrl")
POOL_ID=$(get_output "CognitoUserPoolId")
CLIENT_ID=$(get_output "CognitoUserPoolClientId")
ASSISTANT_WEBHOOK_URL=$(get_output "AssistantWebhookUrl")
POST_CALL_URL=$(get_output "PostCallHandlerUrl")

# ── Optional: create Cognito admin user ───────────────────────────────────────
echo ""
read -rp "Create admin dashboard user now? [y/N] " CREATE_ADMIN
if [[ "${CREATE_ADMIN}" =~ ^[Yy]$ ]]; then
  bash "$(dirname "$0")/setup-cognito.sh" "${ENV}"
fi

# ── Print summary ─────────────────────────────────────────────────────────────
echo ""
echo "================================================"
echo "  ${ENV} Environment Ready"
echo "================================================"
echo ""
echo "Assistant webhook URL:"
echo "  ${ASSISTANT_WEBHOOK_URL}"
echo ""
echo "Post-call handler URL (legacy bridge path):"
echo "  ${POST_CALL_URL}"
echo ""
echo "Dashboard API URL:"
echo "  ${API_URL}"
echo ""
echo "Amplify environment variables for '${ENV}' branch:"
echo "  API_URL=${API_URL}"
echo "  COGNITO_USER_POOL_ID=${POOL_ID}"
echo "  COGNITO_CLIENT_ID=${CLIENT_ID}"
echo "  AWS_REGION=${REGION}"
echo ""
echo "Next steps:"
echo "  1. Apply the database migrations:"
echo "     psql \$DATABASE_URL < db/schema.sql"
echo "     psql \$DATABASE_URL < db/migrations/001_add_settings.sql"
echo "     psql \$DATABASE_URL < db/migrations/002_add_telnyx_assistant_fields.sql"
echo "  2. Create or update the Telnyx assistant:"
echo "     npm run assistant:setup:${ENV}"
echo "  3. Assign your shadow number and run the assistant test suite:"
echo "     npm run assistant:shadow:${ENV}"
echo "     npm run assistant:test:${ENV}"
echo "  4. If not done, run: ./scripts/setup-amplify.sh <github-repo-url>"
echo "  5. Set the Amplify env vars above for the '${ENV}' branch"
