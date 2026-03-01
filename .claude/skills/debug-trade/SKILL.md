---
name: debug-trade
description: Trace the full lifecycle of a trade. Use when the user says "debug trade", "trace trade", "rastreia trade", "o que aconteceu com o trade", "trade history", "why didnt it fill", "por que nao entrou", or wants to investigate a specific trade.
argument-hint: "[COIN | signal_id | alert_id]"
disable-model-invocation: true
allowed-tools: "Bash, Read, Grep"
---

# Debug Trade Lifecycle

Trace the complete lifecycle of a trade from signal to close.

## Expected lifecycle

```
signal_received → risk_check_passed → order_placed (entry) → order_filled (entry)
  → order_placed (sl) → order_placed (tp1/tp2) → position_opened
  → (trailing SL updates) → order_filled (sl/tp) → position_closed
```

## Steps

### 1. Identify the trade

Parse `$ARGUMENTS`:
- If it's a **coin name** (BTC, ETH, SOL): find the most recent signal for that coin
- If it's a **signal_id** (number): search by signal_id
- If it's an **alert_id** (string): search by alert_id
- If empty: ask the user what trade to investigate

### 2. Query daemon endpoints

If the daemon is running (port 3200), fetch structured data:

```bash
curl -sf http://localhost:3200/signals | python3 -m json.tool
```

```bash
curl -sf http://localhost:3200/orders | python3 -m json.tool
```

From the signals response, find the matching signal. From orders, find all orders linked to that signal_id.

### 3. Search event log

Search for all events related to this trade in the NDJSON event log:

```bash
grep -i "{COIN_OR_ID}" /Users/edu/Projects/trading/packages/exchange/data/events.ndjson | tail -30
```

For more precision, search by signal_id or alert_id in the data field.

### 4. Build timeline

Assemble all events chronologically and present as a timeline:

```
14:30:00 ✅ signal_received    — BTC LONG @ 85000, SL: 84200, TP1: 86500
14:30:01 ✅ risk_check_passed  — notional $4250, daily trades: 2/10
14:30:02 ✅ order_placed       — entry market BTC 0.05 (oid: 12345)
14:30:03 ✅ order_filled       — entry filled @ 85010
14:30:04 ✅ order_placed       — SL trigger @ 84200 (oid: 12346)
14:30:04 ✅ order_placed       — TP1 limit @ 86500 (oid: 12347)
14:30:05 ✅ position_opened    — BTC LONG 0.05 @ 85010
```

Use these indicators:
- ✅ for successful steps
- ❌ for errors/failures
- ⚠️ for warnings (e.g. auto_trading_blocked)
- ⏳ for pending/in-progress

### 5. Identify gaps and errors

Check for common issues:
- **Signal without order**: risk_check_failed or auto_trading_blocked
- **Entry without fill**: entry_no_fill (timeout, price moved)
- **Entry order error**: entry_order_error (SDK failure, size rejection)
- **Missing SL/TP**: order placement failed after entry
- **Position without close**: still open or reconcile drift
- **SL rollback**: compensating transaction after SL placement failure

### 6. Diagnosis

Based on the timeline:
- If the trade completed normally, show the P&L and duration
- If something failed, explain what went wrong and suggest a fix
- If the trade is still in progress, show current state and what to expect next
