---
name: positions
description: Show account positions and PnL. Use when the user says "positions", "posicoes", "como ta a conta", "mostra PnL", "check account", "mostra posicoes", "account status", "whats my pnl", or wants to see trading positions.
disable-model-invocation: true
allowed-tools: "Bash, Read, mcp__hyperliquid-info__get_user_state, mcp__hyperliquid-info__get_user_open_orders, mcp__hyperliquid-info__get_all_mids"
---

# Account Positions & PnL

Query the Hyperliquid account and display current positions, open orders, and PnL.

## Steps

### 1. Get the account address

Read the address from the exchange .env file:

```bash
grep HL_ACCOUNT_ADDRESS /Users/edu/Projects/trading/packages/exchange/.env | cut -d= -f2
```

Use this address for all subsequent MCP calls.

### 2. Query account state

Call **all three** MCP tools in parallel:

1. `mcp__hyperliquid-info__get_user_state` with the account address
2. `mcp__hyperliquid-info__get_user_open_orders` with the account address
3. `mcp__hyperliquid-info__get_all_mids` (no args)

### 3. Format output

Present the data in this order:

#### Account Summary
- **Account Value**: from margin_summary
- **Withdrawable**: from withdrawable balance
- **Total Unrealized PnL**: sum of all position unrealized_pnl

#### Open Positions (table)
For each position:
| Coin | Dir | Size | Entry | Current | Unreal PnL | Liq Price |
|------|-----|------|-------|---------|------------|-----------|

- `Dir`: LONG or SHORT
- `Current`: from all_mids (match by coin)
- Format PnL with color indicators: positive = profit, negative = loss

#### Open Orders (table)
For each open order:
| Coin | Side | Size | Price | Type | Reduce Only |
|------|------|------|-------|------|-------------|

- Group by coin
- Identify SL orders (trigger orders, reduce-only) and TP orders (limit, reduce-only)
- Label them as `SL`, `TP1`, `TP2`, or `Entry` based on context

#### Summary
- Number of active positions
- Number of open orders (SL + TP breakdown)
- If no positions: "No open positions"
