---
name: refine
description: Run the BREAKER optimization loop to refine a strategy. Use when the user says "refine", "optimize", "otimiza", "roda o breaker", "breaker-loop", "refina a estrategia", "optimization loop", or wants to iterate on a strategy to improve metrics.
argument-hint: "[--asset=BTC] [--strategy=breakout] [--max-iter=20]"
disable-model-invocation: true
allowed-tools: "Bash, Read"
---

# Run B.R.E.A.K.E.R. Optimization Loop

Run the automated strategy refinement loop (refine → research → restructure phases).

## Steps

### 1. Parse arguments

Extract from `$ARGUMENTS`:
- `--asset`: Coin name (BTC, ETH, SOL). If not provided, ask the user.
- `--strategy`: Strategy category (breakout, mean-reversion). If not provided, ask the user.
- `--max-iter`: Max iterations (default: 20). Optional.

### 2. Verify prerequisites

Build the backtest package (dependency of refiner):
```bash
cd /Users/edu/Projects/trading && pnpm --filter @breaker/backtest build
```

Check breaker-loop.sh exists:
```bash
ls /Users/edu/Projects/trading/packages/refiner/breaker-loop.sh
```

### 3. Run the optimization loop

**Option A** — Via shell script:
```bash
cd /Users/edu/Projects/trading/packages/refiner && ASSET={ASSET} STRATEGY={STRATEGY} MAX_ITER={MAX_ITER} ./breaker-loop.sh
```

**Option B** — Via node directly:
```bash
cd /Users/edu/Projects/trading && pnpm --filter @breaker/refiner start -- --asset={ASSET} --strategy={STRATEGY} --max-iter={MAX_ITER}
```

This will take several minutes per iteration. Let the user know it's running.

### 4. Report results

After completion, read the latest checkpoint:
```bash
ls -lt /Users/edu/Projects/trading/packages/refiner/assets/{ASSET}/*/{STRATEGY}/checkpoints/ | head -5
```

Read the latest metrics file and show: PnL, Profit Factor, Drawdown, Win Rate, Avg R, Trades.
Compare against criteria gates in `packages/refiner/breaker-config.json`.
