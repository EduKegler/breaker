#!/usr/bin/env bash
# Health monitoring for Pine Webhook — runs via cron every 5 min
# Install: crontab -e → */5 * * * * /opt/breaker-webhook/infra/healthcheck.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load credentials from .env (same file used by Docker)
if [ -f "$SCRIPT_DIR/.env" ]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
fi

HEALTH_URL="https://tv.kegler.dev/health"
FAIL_FLAG="/var/tmp/breaker-health-fail"
WHATSAPP_NUMBER="${WHATSAPP_RECIPIENT:-}"
EVO_URL="${EVOLUTION_API_URL:-http://localhost:8080}"
EVO_INSTANCE="${EVOLUTION_INSTANCE:-sexta-feira}"
EVO_KEY="${EVOLUTION_API_KEY:-}"
LOG="/var/log/webhook-health.log"

check_health() {
  curl -sf --max-time 10 "$HEALTH_URL" > /dev/null 2>&1
}

send_whatsapp() {
  local msg="$1"
  if [ -z "$EVO_KEY" ] || [ -z "$WHATSAPP_NUMBER" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') SKIP — missing EVOLUTION_API_KEY or WHATSAPP_RECIPIENT" >> "$LOG"
    return 0
  fi
  curl -sf --max-time 15 \
    -X POST "$EVO_URL/message/sendText/$EVO_INSTANCE" \
    -H "apikey: $EVO_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"number\": \"$WHATSAPP_NUMBER\", \"text\": \"$msg\"}" \
    > /dev/null 2>&1 || true
}

timestamp=$(date '+%Y-%m-%d %H:%M:%S')

if check_health; then
  # Health OK — clear fail flag if it exists
  if [ -f "$FAIL_FLAG" ]; then
    rm -f "$FAIL_FLAG"
    echo "$timestamp OK (recovered)" >> "$LOG"
    send_whatsapp "[B.R.E.A.K.E.R.] Recovered — health check OK again"
  fi
else
  if [ -f "$FAIL_FLAG" ]; then
    # 2nd consecutive failure — alert
    echo "$timestamp ALERT — 2nd consecutive failure" >> "$LOG"
    send_whatsapp "[B.R.E.A.K.E.R.] ALERT — health check failed 2x consecutive. Check: docker compose logs webhook"
  else
    # 1st failure — set flag, wait for next check
    touch "$FAIL_FLAG"
    echo "$timestamp WARN — 1st failure, flag set" >> "$LOG"
  fi
fi
