#!/bin/bash
# deploy.sh — Build and deploy the Aria SAM stack for one environment.
# Usage: ./scripts/deploy.sh <dev|prod>
#
# For first-time setup, use setup-aws.sh instead (also handles S3 + SSM).

set -euo pipefail

ENV="${1:-dev}"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --no-cli-pager)
STACK_NAME="aria-${ENV}"
S3_BUCKET="aria-sam-deploy-${ENV}-${ACCOUNT_ID}"

if [[ "${ENV}" != "dev" && "${ENV}" != "prod" ]]; then
  echo "ERROR: Environment must be 'dev' or 'prod'" >&2
  exit 1
fi

echo "=== Aria ${ENV} Deploy ==="
echo "Stack:  ${STACK_NAME}"
echo "Region: ${REGION}"
echo ""

# Ensure S3 bucket exists
aws s3 mb "s3://${S3_BUCKET}" --region "${REGION}" --no-cli-pager 2>/dev/null || true

# Install Lambda dependencies (shared root install covers all handlers)
echo "Installing Lambda dependencies..."
(cd lambdas && npm install --production --silent)

# Build
sam build --template infrastructure/template.yaml --no-cached

# Deploy
sam deploy \
  --stack-name "${STACK_NAME}" \
  --s3-bucket "${S3_BUCKET}" \
  --region "${REGION}" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides "Environment=${ENV}" \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset

echo ""
echo "=== ${ENV} deploy complete ==="
