#!/usr/bin/env bash
# Structured event logger for B.R.E.A.K.E.R.
# Usage: source lib/emit_event.sh
# Then call: emit_event STAGE STATUS PNL PF DD TRADES "message"

emit_event() {
  local stage="${1:-UNKNOWN}"
  local status="${2:-info}"
  local pnl="${3:-0}"
  local pf="${4:-0}"
  local dd="${5:-0}"
  local trades="${6:-0}"
  local message="${7:-}"
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local iter="${ITER:-0}"
  local run_id="${RUN_ID:-unknown}"
  local asset="${ASSET:-unknown}"
  local strategy="${STRATEGY:-}"
  local artifacts_dir="${ARTIFACTS_DIR:-./artifacts/unknown}"

  mkdir -p "$artifacts_dir"

  # Escape JSON-unsafe chars: backslash, double quote, newline, tab, carriage return
  local safe_msg="$message"
  safe_msg="${safe_msg//\\/\\\\}"
  safe_msg="${safe_msg//\"/\\\"}"
  safe_msg="${safe_msg//$'\n'/\\n}"
  safe_msg="${safe_msg//$'\t'/\\t}"
  safe_msg="${safe_msg//$'\r'/\\r}"

  printf '{"ts":"%s","run_id":"%s","asset":"%s","strategy":"%s","iter":%s,"stage":"%s","status":"%s","pnl":%s,"pf":%s,"dd":%s,"trades":%s,"message":"%s"}\n' \
    "$ts" "$run_id" "$asset" "$strategy" "$iter" "$stage" "$status" \
    "${pnl:-0}" "${pf:-0}" "${dd:-0}" "${trades:-0}" \
    "$safe_msg" \
    >> "$artifacts_dir/events.ndjson" || true
}
