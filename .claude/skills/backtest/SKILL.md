---
name: backtest
description: Run a pure backtest on a strategy and show results. Use when the user says "backtest", "run backtest", "roda backtest", "testa a estrategia", "testa o backtest", or wants to run a single backtest (NOT optimization).
argument-hint: "[BTC] [--strategy=donchian-adx] [--days=180] [--start=2025-06-01] [--end=2026-01-01]"
allowed-tools: "Bash, Read"
---

# Run Pure Backtest

Run a single backtest for a strategy and display results (PF, WR, DD, Avg R, trades).

## Steps

### 1. Parse arguments

Extract from `$ARGUMENTS`:
- Positional coin name (BTC, ETH, SOL). Default: BTC.
- `--strategy`: Strategy name (`donchian-adx` | `keltner-rsi2`). Default: `donchian-adx`.
- `--days`: Number of days to backtest. Default: 180.
- `--start` / `--end`: Date range (YYYY-MM-DD). Overrides `--days` if provided.
- `--source`: Data source (`binance` | `hyperliquid`). Default: `binance`.
- `--cash`: Use cash sizing mode ($100/trade).
- `--no-limits`: Disable trade limits (cooldown, daily loss, max trades).

### 2. Build backtest package

```bash
cd /Users/edu/Projects/trading && pnpm --filter @breaker/backtest build
```

### 3. Run the backtest

```bash
cd /Users/edu/Projects/trading && node packages/backtest/dist/run-backtest.js {COIN} --strategy={STRATEGY} --days={DAYS} [--start={START}] [--end={END}] [--source={SOURCE}] [--cash] [--no-limits]
```

### 4. Report results

The CLI already outputs a formatted table with:
- Period, bars processed, trade count
- Total PnL, Profit Factor, Win Rate, Max Drawdown, Avg R
- Long/Short breakdown
- Walk-Forward analysis (train/test PF, overfit flag)
- Full trade list

Summarize the key metrics to the user. If the user asked for comparison against criteria, read `packages/refiner/breaker-config.json` and compare.
