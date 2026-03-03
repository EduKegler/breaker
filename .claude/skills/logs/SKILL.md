---
name: logs
description: Show daemon event logs and filter by type. Use when the user says "logs", "show logs", "mostra os logs", "event log", "o que aconteceu", "what happened", "errors", "mostra erros", "trades recentes", or wants to see daemon events.
argument-hint: "[errors|trades|reconcile|COIN|N]"
allowed-tools: "Bash, Read, Grep"
---

# Daemon Event Logs

Query and filter the exchange daemon's NDJSON event log.

## Data sources

- **Event log**: `packages/exchange/data/events.ndjson` — 23 event types (structured, append-only)
- **Pino logs**: `packages/exchange/logs/exchange-YYYY-MM-DD.ndjson` — per-module structured logs (daily rotation)

## Event types reference

**Error events**: `error`, `entry_order_error`, `entry_no_fill`, `risk_check_failed`, `notification_failed`, `auto_trading_blocked`

**Trade events**: `signal_received`, `risk_check_passed`, `order_placed`, `order_filled`, `order_cancelled`, `order_rejected`, `position_opened`, `position_closed`

**Reconcile events**: `reconcile_ok`, `reconcile_drift`

**System events**: `daemon_started`, `daemon_stopped`, `warmup_complete`, `leverage_set`, `candle_polled`, `notification_sent`

## Steps

### 1. Determine filter from arguments

Parse `$ARGUMENTS` to determine the filter:

- **No args** → show last 50 events
- **A number** (e.g. `100`) → show last N events
- **`errors`** → filter for error events: `error|entry_order_error|entry_no_fill|risk_check_failed|notification_failed|auto_trading_blocked`
- **`trades`** → filter for trade events: `signal_received|risk_check_passed|order_placed|order_filled|position_opened|position_closed`
- **`reconcile`** → filter for: `reconcile_ok|reconcile_drift`
- **A coin name** (e.g. `BTC`, `ETH`, `SOL`) → filter events containing that coin in the data field
- **`today`** → show today's pino log from `packages/exchange/logs/exchange-YYYY-MM-DD.ndjson`

### 2. Read event log

```bash
tail -n {N} /Users/edu/Projects/trading/packages/exchange/data/events.ndjson
```

Default N=50, or as specified by the user.

### 3. Parse and filter

Each line is a JSON object with `{ type, timestamp, data }`.

If a filter was specified, apply it:
- For type filters: match `type` field against the filter set
- For coin filters: search `data` object for the coin name (case-insensitive)

### 4. Format as table

Present filtered events as:

| Timestamp | Type | Details |
|-----------|------|---------|
| 2026-03-01 14:30:00 | signal_received | BTC LONG @ 85000 |
| 2026-03-01 14:30:01 | risk_check_passed | BTC notional $4250 |
| ... | ... | ... |

- Shorten timestamps to `HH:MM:SS` if all events are from today, otherwise `MM-DD HH:MM`
- Extract the most relevant fields from `data` for the details column
- For **errors** filter: highlight critical events and suggest debugging actions
- For **trades** filter: group events by signal/trade lifecycle when possible

### 5. Summary

At the end, show:
- Total events shown / total in log
- Time range of displayed events
- If errors filter: count by error type
- If trades filter: count signals → fills → closes (conversion funnel)
