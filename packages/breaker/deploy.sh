#!/usr/bin/env bash
set -euo pipefail

# Load deploy config from .deploy.env (not tracked by git)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/.deploy.env" ]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.deploy.env"
fi

VPS_HOST="${VPS_HOST:?ERROR: VPS_HOST not set. Create .deploy.env with VPS_HOST=user@host}"
VPS_DIR="${VPS_DIR:-/opt/breaker-webhook}"
HEALTH_URL="${HEALTH_URL:-https://tv.kegler.dev/health}"

echo "=== Deploy B.R.E.A.K.E.R. ==="

# 1. Sync project structure (excludes .env — secrets stay on VPS)
echo ">> Syncing files to VPS..."
rsync -avz --delete \
  --include='src/***' \
  --include='infra/Dockerfile' \
  --include='infra/docker-compose.yml' \
  --include='infra/Caddyfile' \
  --include='infra/healthcheck.sh' \
  --include='infra/' \
  --include='package.json' \
  --include='pnpm-lock.yaml' \
  --include='tsconfig.json' \
  --exclude='*' \
  ./ "$VPS_HOST:$VPS_DIR/"

# 2. Rebuild and restart on VPS
echo ">> Rebuilding containers on VPS..."
ssh "$VPS_HOST" "cd $VPS_DIR/infra && docker compose up -d --build"

# 3. Wait for startup + health check
echo ">> Waiting 15s for startup + TLS..."
sleep 15

echo ">> Health check..."
HTTP_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$HEALTH_URL" || true)

if [ "$HTTP_STATUS" = "200" ]; then
  echo ">> Deploy OK — health returned 200"
else
  echo ">> WARNING — health returned $HTTP_STATUS (expected 200)"
  echo ">> Check logs: ssh $VPS_HOST 'cd $VPS_DIR && docker compose logs webhook'"
  exit 1
fi
