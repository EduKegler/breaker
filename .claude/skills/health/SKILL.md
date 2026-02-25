---
name: health
description: Check VPS health status. Use when the user says "health", "check server", "is it running?", "webhook status", "status da VPS", "ta rodando?", "como ta o webhook", or wants to check if tv.kegler.dev is running.
disable-model-invocation: true
allowed-tools: "Bash"
---

# VPS Health Check

Check the status of the B.R.E.A.K.E.R. server on tv.kegler.dev.

## Steps

### 1. Check webhook endpoint

```bash
curl -sf -w "\nHTTP Status: %{http_code}\nResponse Time: %{time_total}s\n" https://tv.kegler.dev/health
```

### 2. Check recent webhook logs (if accessible)

```bash
source /Users/edu/Projects/pine/.deploy.env 2>/dev/null && ssh "$VPS_HOST" "tail -20 /opt/breaker-webhook/infra/logs/$(date -u +%Y-%m-%d).ndjson 2>/dev/null || echo 'No logs for today'"
```

If SSH fails, skip this step silently.

### 3. Check Docker container status

```bash
source /Users/edu/Projects/pine/.deploy.env 2>/dev/null && ssh "$VPS_HOST" "cd /opt/breaker-webhook/infra && docker compose ps 2>/dev/null"
```

If SSH fails, skip this step silently.

### 4. Report

Present a summary:
- Webhook status (UP/DOWN + response time)
- Last alerts received (from logs, if available)
- Container status (if available)
