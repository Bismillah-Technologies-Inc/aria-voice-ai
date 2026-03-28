#!/bin/bash
# setup-cognito.sh — Create the first admin user in Cognito after SAM deploy.
# Usage: ./scripts/setup-cognito.sh <dev|prod>
#
# Requires the SAM stack (aria-<env>) to already be deployed.

set -euo pipefail

ENV="${1:?Usage: ./scripts/setup-cognito.sh <dev|prod>}"
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="aria-${ENV}"

echo "=== Aria Cognito Setup: ${ENV} ==="

# Get pool ID from CloudFormation outputs
POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='CognitoUserPoolId'].OutputValue" \
  --output text \
  --region "${REGION}" \
  --no-cli-pager 2>/dev/null || echo "")

if [ -z "${POOL_ID}" ]; then
  echo "ERROR: Could not find Cognito User Pool. Is the '${STACK_NAME}' stack deployed?" >&2
  echo "Run: ./scripts/setup-aws.sh ${ENV}" >&2
  exit 1
fi

echo "User Pool: ${POOL_ID}"
echo ""

read -rp "Admin email: " ADMIN_EMAIL
read -rp "Admin name:  " ADMIN_NAME

if [ -z "${ADMIN_EMAIL}" ]; then
  echo "ERROR: Email cannot be empty" >&2
  exit 1
fi

aws cognito-idp admin-create-user \
  --user-pool-id "${POOL_ID}" \
  --username "${ADMIN_EMAIL}" \
  --user-attributes \
    Name=email,Value="${ADMIN_EMAIL}" \
    Name=name,Value="${ADMIN_NAME:-Admin}" \
    Name=email_verified,Value=true \
  --temporary-password "AriaAdmin1!" \
  --message-action SUPPRESS \
  --region "${REGION}" \
  --no-cli-pager

echo ""
echo "=== Admin user created ==="
echo "Email:    ${ADMIN_EMAIL}"
echo "Temp pw:  AriaAdmin1!"
echo ""
echo "The user will be prompted to set a permanent password on first login."
echo "Navigate to the dashboard URL and sign in with these credentials."
