---
name: compare
description: Compare all strategies of a category side-by-side. Use when the user says "compare", "compara estrategias", "compare strategies", "qual melhor estrategia", "ranking", "mostra todas as estrategias", "compare breakout", "compare mean-reversion", or wants to see how strategies stack up against each other and criteria.
argument-hint: "[BTC] [--category=breakout] [--days=180] [--start=2025-06-01] [--end=2026-01-01]"
allowed-tools: "Bash, Read"
---

# Compare Strategies

Discover all strategies of a given category, run backtests, and show a ranked comparison table with criteria pass/fail.

## Steps

### 1. Parse arguments

Extract from `$ARGUMENTS`:
- Positional coin name (BTC, ETH, SOL). Default: BTC.
- `--category`: Strategy category (`breakout` | `mean-reversion` | `pullback`). Default: `breakout`.
- `--days`: Number of days to backtest. Default: 180.
- `--start` / `--end`: Date range (YYYY-MM-DD). Overrides `--days` if provided.
- `--source`: Data source (`binance` | `hyperliquid`). Default: `binance`.
- `--no-limits`: Disable trade limits.

### 2. Build backtest package

```bash
cd /Users/edu/Projects/trading && pnpm --filter @breaker/backtest build
```

### 3. Run the comparison

```bash
cd /Users/edu/Projects/trading && node packages/backtest/dist/compare-strategies.js {COIN} --category={CATEGORY} --days={DAYS} [--start={START}] [--end={END}] [--source={SOURCE}] [--no-limits]
```

### 4. Present results

The script prints results to stdout inside the Bash tool. The user may not read that raw output carefully, so you MUST build a full, detailed, easy-to-read markdown report from the script output. This is the main deliverable of the skill.

Your report must include ALL of the following sections:

#### 4a. Header
- Asset, category, period, number of strategies found
- Criteria thresholds used (PF, DD, WR, trades, avgR)

#### 4b. Ranking table (markdown table)
Reproduce the ranking as a clean markdown table with columns: #, Strategy, Type, Trades, PF, WR%, DD%, AvgR, PnL, WF, Status (PASS/FAIL). Use checkmarks and crosses for pass/fail.

#### 4c. Per-strategy detail cards
For EACH strategy, show a card with:
- Name, type (deployed/variant), pass/fail status
- All metrics: trades, PF, win rate, max DD, avg R, PnL, expectancy, avg win R, avg loss R, max loss R
- Direction breakdown (long/short counts and win rates)
- Walk-forward results (train PF, test PF, ratio, overfit flag)
- Param count (flag if >8)
- If failing: list exactly which criteria fail and by how much

#### 4d. Verdict & analysis
- How many pass vs total
- Best strategy and why
- If none pass: which is closest, what needs to improve, and by how much
- Compare deployed vs variants: is the deployed still the best? Any variant close to overtaking?
- Actionable observations: what should the user focus on to improve results?

Be thorough and detailed. The user wants a comprehensive, well-formatted report — not a summary.
