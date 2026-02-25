#!/usr/bin/env bash
# breaker-loop.sh — Thin wrapper for the TypeScript orchestrator.
#
# Usage:
#   ASSET=BTC STRATEGY=breakout ./breaker-loop.sh
#   ASSET=BTC STRATEGY=mean-reversion ./breaker-loop.sh
#   ASSET=ETH STRATEGY=breakout MAX_ITER=5 ./breaker-loop.sh
#   AUTO_COMMIT=true ASSET=BTC ./breaker-loop.sh
#
# All logic now lives in src/loop/orchestrator.ts (dist/loop/orchestrator.js).

set -euo pipefail

# Allow running claude CLI inside an active Claude Code session
unset CLAUDECODE 2>/dev/null || true

# Load environment variables (.pine.env)
# shellcheck disable=SC1090,SC1091
set -a  # auto-export all sourced vars
[ -f "${HOME}/.pine.env" ] && source "${HOME}/.pine.env" 2>/dev/null || true
set +a

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Validate ASSET ---
ASSET="${ASSET:-BTC}"
if [[ ! "$ASSET" =~ ^[A-Za-z0-9-]+$ ]]; then
  echo "[breaker] ERROR: ASSET contains invalid characters: '${ASSET}'."
  exit 1
fi

# --- Validate STRATEGY ---
STRATEGY="${STRATEGY:-breakout}"
if [[ ! "$STRATEGY" =~ ^[A-Za-z0-9-]+$ ]]; then
  echo "[breaker] ERROR: STRATEGY contains invalid characters: '${STRATEGY}'."
  exit 1
fi

MAX_ITER="${MAX_ITER:-10}"
AUTO_COMMIT="${AUTO_COMMIT:-false}"
HEADLESS="${HEADLESS:-true}"
export HEADLESS

# --- Build TypeScript (skip if caller already built) ---
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "[breaker] Building TypeScript..."
  cd "$REPO_ROOT" && pnpm build
fi

# --- Collect extra args (e.g., --phase=restructure) ---
EXTRA_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --asset=*) ASSET="${arg#*=}" ;;
    --strategy=*) STRATEGY="${arg#*=}" ;;
    --max-iter=*) MAX_ITER="${arg#*=}" ;;
    --auto-commit=*) AUTO_COMMIT="${arg#*=}" ;;
    *) EXTRA_ARGS+=("$arg") ;;
  esac
done

# --- Delegate to orchestrator ---
exec node dist/loop/orchestrator.js \
  --asset="$ASSET" \
  --strategy="$STRATEGY" \
  --max-iter="$MAX_ITER" \
  --auto-commit="$AUTO_COMMIT" \
  --repo-root="$REPO_ROOT" \
  ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
