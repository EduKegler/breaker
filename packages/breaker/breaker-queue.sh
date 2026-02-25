#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Queue format: "ASSET:STRATEGY" pairs, space-separated
QUEUE="${QUEUE:-BTC:breakout BTC:mean-reversion}"
MAX_ITER="${MAX_ITER:-10}"

echo "[queue] Queue: ${QUEUE} | MAX_ITER=${MAX_ITER}"

# Build once before launching parallel workers
echo "[queue] Building TypeScript..."
cd "$REPO_ROOT" && pnpm build

PIDS=()
LABELS=()
for ENTRY in $QUEUE; do
    ASSET="${ENTRY%%:*}"
    STRATEGY="${ENTRY#*:}"
    # If no colon found, default strategy to breakout
    if [ "$STRATEGY" = "$ASSET" ]; then
        STRATEGY="breakout"
    fi
    LABEL="${ASSET}/${STRATEGY}"
    LABELS+=("$LABEL")
    echo "[queue] Launching ${LABEL} in background..."
    ASSET="$ASSET" STRATEGY="$STRATEGY" MAX_ITER="$MAX_ITER" SKIP_BUILD=1 "$REPO_ROOT/breaker-loop.sh" &
    PIDS+=($!)
done

# Wait for all and track results
PASSED=0; FAILED=0; i=0
for pid in "${PIDS[@]}"; do
    LABEL="${LABELS[$i]}"
    if wait "$pid"; then
        PASSED=$((PASSED + 1))
        echo "[queue] ${LABEL}: OK"
    else
        FAILED=$((FAILED + 1))
        echo "[queue] ${LABEL}: FAILED"
    fi
    i=$((i + 1))
done

echo "[queue] Result: ${PASSED} ok, ${FAILED} failed"
[ "$FAILED" -eq 0 ]
