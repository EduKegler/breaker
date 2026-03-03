---
name: daemon-status
description: Full health check of the exchange daemon. Use when the user says "daemon status", "daemon ta rodando?", "como ta o daemon", "exchange health", "status completo", "full health check", or wants a comprehensive daemon status.
allowed-tools: "Bash, Read"
---

# Daemon Full Status Check

Comprehensive health check of the local exchange daemon.

## Steps

### 1. Check health endpoint

```bash
curl -sf http://localhost:3200/health
```

If this fails, the daemon is DOWN. Check process and skip to step 6.

### 2. Check config

```bash
curl -sf http://localhost:3200/config
```

Extract: mode, coins, strategies per coin, autoTradingEnabled per strategy, dryRun.

### 3. Check positions

```bash
curl -sf http://localhost:3200/positions
```

List open positions with coin, direction, size, entry price, PnL.

### 4. Check open orders

```bash
curl -sf http://localhost:3200/open-orders
```

List open orders (SL/TP for each position).

### 5. Check process

```bash
lsof -i :3200 2>/dev/null
```

Show PID, command, and how long it's been running.

### 6. Check recent events

Read the last 30 lines of the event log:

```bash
tail -30 /Users/edu/Projects/trading/packages/exchange/data/events.ndjson 2>/dev/null
```

Highlight any errors or anomalies.

### 7. Check today's pino logs for errors

```bash
grep -c '"level":50' /Users/edu/Projects/trading/packages/exchange/logs/exchange-$(date +%Y-%m-%d).ndjson 2>/dev/null || echo "0"
```

Level 50 = error in pino.

### 8. Present summary

Format as a dashboard:

```
═══ DAEMON STATUS ═══════════════════════════════
Status:    🟢 UP (or 🔴 DOWN)
Mode:      mainnet | testnet | dry-run
Uptime:    X hours Y minutes
Port:      3200

═══ TRADING ═════════════════════════════════════
Auto-Trading: ✅ enabled (or ❌ disabled) per strategy
Coins:     BTC (donchian-adx 15m), ETH (keltner-rsi2 15m)

═══ POSITIONS ═══════════════════════════════════
BTC LONG  0.05 @ 85000  PnL: +$125
(or "No open positions")

═══ ORDERS ══════════════════════════════════════
BTC SL @ 84200 | TP1 @ 86500 | TP2 @ 88000
(or "No open orders")

═══ RECENT EVENTS ═══════════════════════════════
Last 5 events: ...
Errors today: 0
═════════════════════════════════════════════════
```

If daemon is DOWN, suggest:
```bash
cd /Users/edu/Projects/trading && pnpm --filter @breaker/exchange start
```
