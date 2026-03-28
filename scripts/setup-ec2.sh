#!/bin/bash
# setup-ec2.sh — Provision an EC2 t3.micro for the Aria WebSocket bridge server.
# Usage: ./scripts/setup-ec2.sh [dev|prod]
#
# Prerequisites:
#   - AWS CLI v2 configured
#   - An SSH key pair in the target region (set KEY_PAIR_NAME below or via env)
#   - Domain DNS pointing stream.bismillahtech.ai → this server's Elastic IP
#     (add the A record AFTER running this script with the printed IP)
#
# What this script does:
#   1. Creates a security group (TCP 22 + 443)
#   2. Launches a t3.micro from Amazon Linux 2023
#   3. Allocates + associates an Elastic IP
#   4. Prints the IP and next steps

set -euo pipefail

ENV="${1:-dev}"
REGION="${AWS_REGION:-us-east-1}"
KEY_PAIR_NAME="${EC2_KEY_PAIR:-aria-key}"
INSTANCE_TYPE="t3.micro"
REPO_URL="${GIT_REPO_URL:-}"   # set via env or edit below

if [[ "${ENV}" != "dev" && "${ENV}" != "prod" ]]; then
  echo "ERROR: Environment must be 'dev' or 'prod'" >&2
  exit 1
fi

echo "=== Aria EC2 Bridge Setup: ${ENV} ==="
echo "Region: ${REGION}"
echo ""

# ── 1. Security Group ─────────────────────────────────────────────────────────

SG_NAME="aria-${ENV}-bridge-sg"
echo "Creating security group: ${SG_NAME}..."

SG_ID=$(aws ec2 create-security-group \
  --group-name "${SG_NAME}" \
  --description "Aria bridge server — SSH + HTTPS" \
  --region "${REGION}" \
  --no-cli-pager \
  --query 'GroupId' --output text 2>/dev/null || \
  aws ec2 describe-security-groups \
    --filters "Name=group-name,Values=${SG_NAME}" \
    --region "${REGION}" \
    --no-cli-pager \
    --query 'SecurityGroups[0].GroupId' --output text)

echo "  Security group: ${SG_ID}"

# Allow SSH and HTTPS (Telnyx connects via WSS/443)
aws ec2 authorize-security-group-ingress \
  --group-id "${SG_ID}" \
  --ip-permissions \
    "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=0.0.0.0/0}]" \
    "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]" \
  --region "${REGION}" \
  --no-cli-pager 2>/dev/null || true   # idempotent

# ── 2. Get Latest Amazon Linux 2023 AMI ──────────────────────────────────────

echo "Finding latest Amazon Linux 2023 AMI..."
AMI_ID=$(aws ec2 describe-images \
  --owners amazon \
  --filters \
    "Name=name,Values=al2023-ami-*-x86_64" \
    "Name=state,Values=available" \
  --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
  --output text \
  --region "${REGION}" \
  --no-cli-pager)
echo "  AMI: ${AMI_ID}"

# ── 3. User Data Script ───────────────────────────────────────────────────────

USER_DATA=$(cat <<'USERDATA'
#!/bin/bash
set -e
exec > >(tee /var/log/aria-setup.log) 2>&1

echo "=== Aria Bridge Server Setup ==="

# Install Node.js 20 via NodeSource
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs nginx git

# Install PM2 + Certbot globally
npm install -g pm2
dnf install -y python3-certbot-nginx || pip3 install certbot certbot-nginx

# Clone repo (update URL if private — add deploy key first)
REPO_URL="${ARIA_REPO_URL}"
if [ -n "${REPO_URL}" ]; then
  git clone "${REPO_URL}" /home/ec2-user/aria
else
  mkdir -p /home/ec2-user/aria
  echo "WARNING: No ARIA_REPO_URL set. Upload code manually or re-run with GIT_REPO_URL set."
fi

chown -R ec2-user:ec2-user /home/ec2-user/aria

# Install dependencies
if [ -d /home/ec2-user/aria/ec2 ]; then
  (cd /home/ec2-user/aria/ec2 && sudo -u ec2-user npm install --production)
fi
if [ -d /home/ec2-user/aria/lambdas ]; then
  (cd /home/ec2-user/aria/lambdas && sudo -u ec2-user npm install --production)
fi

# Nginx reverse proxy config
cat > /etc/nginx/conf.d/aria.conf <<'NGINX'
server {
    listen 80;
    server_name stream.bismillahtech.ai;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
    }
}
NGINX

systemctl enable nginx
systemctl start nginx

# Note: Run certbot manually after DNS propagates:
# certbot --nginx -d stream.bismillahtech.ai

# PM2 ecosystem file
cat > /home/ec2-user/aria/ecosystem.config.cjs <<'PM2'
module.exports = {
  apps: [{
    name:        'aria-bridge',
    script:      'ec2/server.mjs',
    cwd:         '/home/ec2-user/aria',
    node_args:   '--env-file /home/ec2-user/aria/.env',
    restart_delay: 3000,
    max_restarts:  10,
  }]
};
PM2

chown ec2-user:ec2-user /home/ec2-user/aria/ecosystem.config.cjs

echo "=== Setup complete. Next steps:"
echo "1. Copy .env.dev to /home/ec2-user/aria/.env"
echo "2. Run: sudo -u ec2-user pm2 start /home/ec2-user/aria/ecosystem.config.cjs"
echo "3. Run: sudo -u ec2-user pm2 save && sudo env PATH=\$PATH pm2 startup systemd -u ec2-user --hp /home/ec2-user"
echo "4. Add DNS A record for stream.bismillahtech.ai pointing to this instance's Elastic IP"
echo "5. Run: certbot --nginx -d stream.bismillahtech.ai"
USERDATA
)

# ── 4. Launch Instance ────────────────────────────────────────────────────────

echo "Launching EC2 instance..."
INSTANCE_ID=$(aws ec2 run-instances \
  --image-id "${AMI_ID}" \
  --instance-type "${INSTANCE_TYPE}" \
  --key-name "${KEY_PAIR_NAME}" \
  --security-group-ids "${SG_ID}" \
  --user-data "${USER_DATA}" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=aria-${ENV}-bridge},{Key=Environment,Value=${ENV}}]" \
  --region "${REGION}" \
  --no-cli-pager \
  --query 'Instances[0].InstanceId' --output text)

echo "  Instance: ${INSTANCE_ID}"
echo "  Waiting for instance to be running..."
aws ec2 wait instance-running \
  --instance-ids "${INSTANCE_ID}" \
  --region "${REGION}" \
  --no-cli-pager

# ── 5. Allocate + Associate Elastic IP ───────────────────────────────────────

echo "Allocating Elastic IP..."
ALLOCATION_ID=$(aws ec2 allocate-address \
  --domain vpc \
  --region "${REGION}" \
  --no-cli-pager \
  --query 'AllocationId' --output text)

ELASTIC_IP=$(aws ec2 describe-addresses \
  --allocation-ids "${ALLOCATION_ID}" \
  --region "${REGION}" \
  --no-cli-pager \
  --query 'Addresses[0].PublicIp' --output text)

aws ec2 associate-address \
  --instance-id "${INSTANCE_ID}" \
  --allocation-id "${ALLOCATION_ID}" \
  --region "${REGION}" \
  --no-cli-pager > /dev/null

echo "  Elastic IP: ${ELASTIC_IP}"

# ── 6. Summary ────────────────────────────────────────────────────────────────

echo ""
echo "=== EC2 Bridge Setup Complete ==="
echo ""
echo "Instance ID:  ${INSTANCE_ID}"
echo "Elastic IP:   ${ELASTIC_IP}"
echo ""
echo "Next steps:"
echo "  1. Add DNS A record:"
echo "     stream.bismillahtech.ai  →  ${ELASTIC_IP}"
echo ""
echo "  2. Copy env file to server:"
echo "     scp .env.${ENV} ec2-user@${ELASTIC_IP}:/home/ec2-user/aria/.env"
echo ""
echo "  3. SSH in and start the bridge:"
echo "     ssh ec2-user@${ELASTIC_IP}"
echo "     pm2 start /home/ec2-user/aria/ecosystem.config.cjs"
echo "     pm2 save && sudo env PATH=\$PATH pm2 startup systemd -u ec2-user --hp /home/ec2-user"
echo ""
echo "  4. After DNS propagates (~5 min), run Certbot:"
echo "     ssh ec2-user@${ELASTIC_IP} 'sudo certbot --nginx -d stream.bismillahtech.ai --non-interactive --agree-tos -m admin@bismillahtech.ai'"
echo ""
echo "  5. Deploy SAM stack to get PostCallHandlerUrl:"
echo "     bash scripts/deploy.sh ${ENV}"
echo "     # Then add POST_CALL_HANDLER_URL to .env.${ENV} and re-copy to server"
echo ""
echo "  6. Configure Telnyx TeXML app:"
echo "     Webhook URL: https://stream.bismillahtech.ai/telnyx/voice"
echo "     Assign your phone number to the app"
