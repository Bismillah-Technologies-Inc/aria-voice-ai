#!/bin/bash
# setup-amplify.sh — Create Amplify app and connect dev + prod branches.
# Usage: ./scripts/setup-amplify.sh <github-repo-url>
#
# Reads SAM stack outputs for dev and prod to populate Amplify env vars.
# Both stacks must already be deployed before running this script.
#
# Example:
#   ./scripts/setup-amplify.sh https://github.com/bismillahtech/aria-mvp

set -euo pipefail

REPO_URL="${1:?Usage: ./scripts/setup-amplify.sh <github-repo-url>}"
REGION="${AWS_REGION:-us-east-1}"

echo "=== Aria Amplify Setup ==="
echo "Repo: ${REPO_URL}"
echo ""

# ── Helper: get a CloudFormation output ──────────────────────────────────────
get_output() {
  local stack=$1
  local key=$2
  aws cloudformation describe-stacks \
    --stack-name "${stack}" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" \
    --output text \
    --region "${REGION}" \
    --no-cli-pager 2>/dev/null || echo ""
}

# ── Pull dev outputs ──────────────────────────────────────────────────────────
echo "Reading dev stack outputs..."
DEV_API_URL=$(get_output "aria-dev" "DashboardApiUrl")
DEV_POOL_ID=$(get_output "aria-dev" "CognitoUserPoolId")
DEV_CLIENT_ID=$(get_output "aria-dev" "CognitoUserPoolClientId")

if [ -z "${DEV_API_URL}" ]; then
  echo "WARN: aria-dev stack not found or not deployed yet."
  echo "  You can manually set Amplify env vars after deployment."
  DEV_API_URL="REPLACE_ME"
  DEV_POOL_ID="REPLACE_ME"
  DEV_CLIENT_ID="REPLACE_ME"
fi

# ── Pull prod outputs ─────────────────────────────────────────────────────────
echo "Reading prod stack outputs..."
PROD_API_URL=$(get_output "aria-prod" "DashboardApiUrl")
PROD_POOL_ID=$(get_output "aria-prod" "CognitoUserPoolId")
PROD_CLIENT_ID=$(get_output "aria-prod" "CognitoUserPoolClientId")

if [ -z "${PROD_API_URL}" ]; then
  echo "WARN: aria-prod stack not found or not deployed yet."
  PROD_API_URL="REPLACE_ME"
  PROD_POOL_ID="REPLACE_ME"
  PROD_CLIENT_ID="REPLACE_ME"
fi

# ── Create Amplify app ────────────────────────────────────────────────────────
echo ""
echo "Creating Amplify app..."

APP_ID=$(aws amplify create-app \
  --name "aria-dashboard" \
  --repository "${REPO_URL}" \
  --platform WEB \
  --region "${REGION}" \
  --no-cli-pager \
  --query 'app.appId' \
  --output text)

echo "Amplify App ID: ${APP_ID}"

# ── Connect dev branch ────────────────────────────────────────────────────────
echo "Connecting 'dev' branch..."

aws amplify create-branch \
  --app-id "${APP_ID}" \
  --branch-name dev \
  --stage DEVELOPMENT \
  --framework "React" \
  --environment-variables \
    "API_URL=${DEV_API_URL},COGNITO_USER_POOL_ID=${DEV_POOL_ID},COGNITO_CLIENT_ID=${DEV_CLIENT_ID},AWS_REGION=${REGION}" \
  --region "${REGION}" \
  --no-cli-pager \
  > /dev/null

echo "  ✓ dev branch connected"

# ── Connect main (prod) branch ────────────────────────────────────────────────
echo "Connecting 'main' branch..."

aws amplify create-branch \
  --app-id "${APP_ID}" \
  --branch-name main \
  --stage PRODUCTION \
  --framework "React" \
  --environment-variables \
    "API_URL=${PROD_API_URL},COGNITO_USER_POOL_ID=${PROD_POOL_ID},COGNITO_CLIENT_ID=${PROD_CLIENT_ID},AWS_REGION=${REGION}" \
  --region "${REGION}" \
  --no-cli-pager \
  > /dev/null

echo "  ✓ main branch connected"

# ── Custom domain ─────────────────────────────────────────────────────────────
echo ""
echo "Setting up custom domain: bismillahtech.ai"

aws amplify create-domain-association \
  --app-id "${APP_ID}" \
  --domain-name "bismillahtech.ai" \
  --sub-domain-settings \
    "prefix=aria,branchName=main" \
    "prefix=dev.aria,branchName=dev" \
  --region "${REGION}" \
  --no-cli-pager \
  > /dev/null || echo "  NOTE: Domain association may require manual DNS verification in the Amplify console."

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "=== Amplify Setup Complete ==="
echo "App ID:   ${APP_ID}"
echo ""
echo "URLs (after DNS propagation):"
echo "  Prod:  https://aria.bismillahtech.ai"
echo "  Dev:   https://dev.aria.bismillahtech.ai"
echo ""
echo "Amplify default URLs (available immediately):"
echo "  Prod:  https://main.${APP_ID}.amplifyapp.com"
echo "  Dev:   https://dev.${APP_ID}.amplifyapp.com"
echo ""
echo "IMPORTANT: Add these CNAME records to bismillahtech.ai DNS:"
echo "  aria        -> main.${APP_ID}.amplifyapp.com"
echo "  dev.aria    -> dev.${APP_ID}.amplifyapp.com"
echo ""
echo "Then verify ownership in the Amplify console:"
echo "  https://${REGION}.console.aws.amazon.com/amplify/home?region=${REGION}#/${APP_ID}"
