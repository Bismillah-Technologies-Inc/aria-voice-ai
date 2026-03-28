#!/bin/bash
# deploy-ec2.sh — Deploy updated code to the running EC2 bridge server.
# Usage: ./scripts/deploy-ec2.sh [host]
#
# Default host: stream.bismillahtech.ai
# Override:     EC2_HOST=1.2.3.4 ./scripts/deploy-ec2.sh

set -euo pipefail

HOST="${1:-${EC2_HOST:-stream.bismillahtech.ai}}"
SSH_USER="${EC2_USER:-ec2-user}"
REPO_DIR="/home/${SSH_USER}/aria"

echo "=== Deploying to ${SSH_USER}@${HOST} ==="

ssh "${SSH_USER}@${HOST}" bash <<REMOTE
  set -e
  cd ${REPO_DIR}
  echo "Pulling latest code..."
  git pull
  echo "Installing Lambda deps..."
  (cd lambdas && npm install --production --silent)
  echo "Restarting aria-bridge..."
  pm2 restart aria-bridge
  echo "Done."
  pm2 status aria-bridge
REMOTE

echo "=== Deploy complete ==="
