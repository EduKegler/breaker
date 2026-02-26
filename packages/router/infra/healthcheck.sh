#!/usr/bin/env bash
# Health monitoring for TV Webhook — runs via cron every 5 min
# Install: crontab -e -> */5 * * * * /opt/webhook/infra/healthcheck.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/.env" ]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
fi

HEALTH_URL="https://tv.kegler.dev/health"
FAIL_FLAG="/var/tmp/webhook-health-fail"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:3100}"
LOG="/var/log/webhook-health.log"

check_health() {
  curl -sf --max-time 10 "$HEALTH_URL" > /dev/null 2>&1
}

send_alert() {
  local msg="$1"
  curl -sf --max-time 15 \
    -X POST "$GATEWAY_URL/send" \
    -H "Content-Type: application/json" \
    -d "{\"text\": \"$msg\"}" \
    > /dev/null 2>&1 || true
}

timestamp=$(date '+%Y-%m-%d %H:%M:%S')

if check_health; then
  if [ -f "$FAIL_FLAG" ]; then
    rm -f "$FAIL_FLAG"
    echo "$timestamp OK (recovered)" >> "$LOG"
    send_alert "[WEBHOOK] Recovered — health check OK again"
  fi
else
  if [ -f "$FAIL_FLAG" ]; then
    echo "$timestamp ALERT — 2nd consecutive failure" >> "$LOG"
    send_alert "[WEBHOOK] ALERT — health check failed 2x consecutive. Check: docker compose logs webhook"
  else
    touch "$FAIL_FLAG"
    echo "$timestamp WARN — 1st failure, flag set" >> "$LOG"
  fi
fi
