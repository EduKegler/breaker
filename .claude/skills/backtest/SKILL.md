---
name: backtest
description: Run a backtest via breaker-loop. Use when the user says "backtest", "run backtest", "test the strategy", "breaker-loop", "optimize", "roda backtest", "testa a estrategia", "otimiza", or wants to run the strategy optimization loop.
argument-hint: "[ASSET] [MAX_ITER]"
disable-model-invocation: true
allowed-tools: "Bash, Read"
---

# Run Backtest (B.R.E.A.K.E.R.)

Run the strategy optimization loop for a given asset.

## Steps

### 1. Parse arguments

- `$ARGUMENTS[0]` or `$0`: Asset name (BTC, ETH, SOL). If not provided, ask the user.
- `$ARGUMENTS[1]` or `$1`: Max iterations (default: 5). Optional.

### 2. Verify prerequisites

Check that the strategy file exists:
```bash
ls /Users/edu/Projects/pine/assets/{ASSET}/strategy.pine
```

Check that Playwright auth exists:
```bash
ls /Users/edu/Projects/pine/playwright/.auth/
```

If auth is missing, suggest running `pnpm run login` first.

### 3. Run breaker-loop

```bash
cd /Users/edu/Projects/pine && ASSET={ASSET} MAX_ITER={MAX_ITER} ./breaker-loop.sh
```

This will take several minutes per iteration. Let the user know it's running.

### 4. Report results

After completion, read the latest results:
```bash
cat /Users/edu/Projects/pine/assets/{ASSET}/checkpoints/best-metrics.json
```

Show: PnL, Profit Factor, Drawdown, Win Rate, Avg R, Trades. Compare against gates (from breaker-config.json).
