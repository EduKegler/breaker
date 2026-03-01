---
name: health
description: Quick health check of the exchange daemon. Use when the user says "health", "is it running?", "ta rodando?", "status do daemon", "como ta o webhook", or wants a quick daemon check.
disable-model-invocation: true
allowed-tools: "Bash, Read"
---

# Daemon Quick Health Check

Quick check of the local exchange daemon on port 3200.

## Steps

### 1. Check health endpoint

```bash
curl -sf -w "\nHTTP Status: %{http_code}\nResponse Time: %{time_total}s\n" http://localhost:3200/health
```

### 2. Check process

```bash
lsof -i :3200 2>/dev/null || echo "No process listening on port 3200"
```

### 3. Report

Present a summary:
- Daemon status (UP/DOWN + response time)
- Mode (mainnet/testnet/dry-run)
- Coins being traded
- Uptime
- If DOWN: suggest starting with `cd /Users/edu/Projects/trading && pnpm --filter @breaker/exchange start`
